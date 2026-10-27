/*
 * Copyright (c) 2026, SimplySF.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// What a request was meant to carry to the model, what it carried, and why anything was left out
// (ADR-054). Each included piece of context starts with a short marker, so the engine can confirm,
// just before sending, that every piece is in the payload whole; a request that fails the check is
// refused rather than sent with context silently missing.

import type { AttachmentsReport } from '../api/types.js';
import { droppedNote } from './reply.js';

/**
 * `notes` are what one batch of a thorough answer found, sent to the request that combines them. An
 * `attachment` is read inside its page's text, so it is counted rather than marked (ADR-069).
 */
export type ContextKind = 'page' | 'section' | 'file' | 'turn' | 'notes' | 'image' | 'attachment';
/** `not-read` is an attachment that was not read, or not read whole, with its own `why`. */
export type LeftOutReason = 'excluded' | 'secret' | 'over-limit' | 'history-limit' | 'not-read';

export type ManifestItem = {
  kind: ContextKind;
  /** The page, section or file's name; empty for an excluded page, which is never named. */
  label: string;
  chars: number;
  included: boolean;
  reason?: LeftOutReason;
  /** A file sent in part because it was longer than a file may contribute. */
  cut?: boolean;
  marker?: string;
  /** Why an attachment was not read, in words, as its reason alone cannot say. */
  why?: string;
};

export type ContextManifest = { items: ManifestItem[] };

/** What an answer shows under What was sent: counts and sizes, and each item left out with why. */
export type ManifestSummary = {
  pages: number;
  sections: number;
  files: number;
  turns: number;
  /** Images sent with the context, unchecked by the guard (ADR-066). */
  images?: number;
  /** Attachments read with their pages (ADR-069). */
  attachments?: number;
  chars: number;
  leftOut: Array<{ kind: ContextKind; label: string; reason: LeftOutReason | 'cut'; why?: string }>;
};

/** A thing that should never happen: context the request was built to carry is missing from it. */
export class ContextCheckError extends Error {
  public readonly status = 500;

  public constructor(public readonly problems: string[]) {
    super(`Not sent: the request was missing context it was built to carry (${problems.slice(0, 3).join('; ')}).`);
  }
}

export class ManifestBuilder {
  private readonly items: ManifestItem[] = [];
  private next = 0;

  /** Records a piece of context as sent, and returns its text with the marker the check looks for. */
  public include(kind: ContextKind, label: string, text: string, cut = false): string {
    const marker = `⟦c${++this.next}⟧`;
    this.items.push({ kind, label, chars: text.length, included: true, marker, ...(cut ? { cut } : {}) });
    return `${marker} ${text}`;
  }

  /** Records earlier turns of a conversation that were sent; they travel as messages, not context. */
  public includeTurns(count: number, chars: number): void {
    if (count > 0) this.items.push({ kind: 'turn', label: `${count} earlier messages`, chars, included: true });
  }

  /** Records images sent with the context; they travel beside the text, so they carry no marker. */
  public includeImages(images: Array<{ name: string; bytes: number }>): void {
    for (const image of images) this.items.push({ kind: 'image', label: image.name, chars: 0, included: true });
  }

  public leaveOut(kind: ContextKind, label: string, chars: number, reason: LeftOutReason, why?: string): void {
    this.items.push({
      kind,
      label: reason === 'excluded' ? '' : label,
      chars,
      included: false,
      reason,
      ...(why ? { why } : {}),
    });
  }

  /**
   * Records the attachments a request read with its pages, and names each one it did not read, or
   * read only in part, with why, so What was sent never claims more than reached the model (ADR-069).
   */
  public includeAttachments(report: AttachmentsReport): void {
    for (const r of report.read) {
      this.items.push({ kind: 'attachment', label: `${r.page} / ${r.name}`, chars: 0, included: true });
      if (r.cut)
        this.leaveOut(
          'attachment',
          `${r.page} / ${r.name}`,
          0,
          'not-read',
          `only its first ${r.cut.toLocaleString('en')} characters were read`,
        );
    }
    for (const u of report.unread) this.leaveOut('attachment', `${u.page} / ${u.name}`, 0, 'not-read', u.why);
  }

  public build(): ContextManifest {
    return { items: [...this.items] };
  }
}

/**
 * The problems with a payload: each included item whose marker is missing from what is sent, or whose
 * text after the marker was much shorter than the item when the request was put together, as when it
 * was cut on its way. The length is measured before the leak guard, which replaces values such as
 * email addresses with shorter placeholders and so would make a page of them look cut; the guard
 * never removes text, and every marker must still be in what is sent.
 *
 * @param manifest What the request was built to carry.
 * @param sent Everything the request will send, as one string.
 * @param built The same before the leak guard, where each item's length is measured.
 */
export function checkPayload(manifest: ContextManifest, sent: string, built = sent): string[] {
  const marked = manifest.items.filter((i) => i.included && i.marker);
  const positions = marked.map((i) => built.indexOf(i.marker!));
  const problems: string[] = [];
  marked.forEach((item, n) => {
    const at = positions[n];
    const name = item.label || `an item of kind ${item.kind}`;
    if (at < 0 || !sent.includes(item.marker!)) {
      problems.push(`${name} is missing`);
      return;
    }
    const following = positions.filter((p) => p > at);
    const end = following.length ? Math.min(...following) : built.length;
    const carried = end - at - item.marker!.length - 1;
    if (carried < item.chars * 0.8 - 100)
      problems.push(`${name} arrived with ${carried} of its ${item.chars} characters`);
  });
  return problems;
}

/** The problem when the images a request was built to carry are not all in it. */
export function checkImages(manifest: ContextManifest, sent: number): string[] {
  const listed = manifest.items.filter((i) => i.included && i.kind === 'image').length;
  return sent < listed ? [`${listed - sent} of its ${listed} images are missing`] : [];
}

export function summarise(manifest: ContextManifest): ManifestSummary {
  const sent = manifest.items.filter((i) => i.included);
  const count = (kind: ContextKind): number => sent.filter((i) => i.kind === kind).length;
  const turns = sent.filter((i) => i.kind === 'turn').reduce((n, i) => n + Number(i.label.split(' ')[0]), 0);
  return {
    pages: count('page'),
    sections: count('section'),
    files: count('file'),
    turns,
    ...(count('image') ? { images: count('image') } : {}),
    ...(count('attachment') ? { attachments: count('attachment') } : {}),
    chars: sent.reduce((n, i) => n + i.chars, 0),
    leftOut: [
      ...manifest.items
        .filter((i) => !i.included)
        .map((i) => ({ kind: i.kind, label: i.label, reason: i.reason!, ...(i.why ? { why: i.why } : {}) })),
      ...sent.filter((i) => i.cut).map((i) => ({ kind: i.kind, label: i.label, reason: 'cut' as const })),
    ],
  };
}

/**
 * What was sent, once the provider gave no answer with some images and was asked again without them:
 * those images are no longer counted as sent, and each is named as not read (ADR-069).
 */
export function droppedFrom(
  summary: ManifestSummary,
  dropped: string[] | undefined,
  whyDropped?: string,
): ManifestSummary {
  if (!dropped?.length) return summary;
  const images = Math.max(0, (summary.images ?? 0) - dropped.length);
  return {
    ...summary,
    ...(images ? { images } : { images: undefined }),
    leftOut: [
      ...summary.leftOut,
      ...dropped.map((label) => ({
        kind: 'image' as const,
        label,
        reason: 'not-read' as const,
        why: droppedNote(whyDropped),
      })),
    ],
  };
}

/**
 * What several requests carried together, as one answer made over several requests shows it. The
 * conversation's earlier messages travel with each request, so they are counted once.
 */
export function mergeSummaries(summaries: ManifestSummary[]): ManifestSummary {
  const sum = (field: 'pages' | 'sections' | 'files' | 'chars'): number => summaries.reduce((n, s) => n + s[field], 0);
  return {
    pages: sum('pages'),
    sections: sum('sections'),
    files: Math.max(0, ...summaries.map((s) => s.files)),
    turns: Math.max(0, ...summaries.map((s) => s.turns)),
    ...(summaries.some((s) => s.images) ? { images: summaries.reduce((n, s) => n + (s.images ?? 0), 0) } : {}),
    ...(summaries.some((s) => s.attachments)
      ? { attachments: summaries.reduce((n, s) => n + (s.attachments ?? 0), 0) }
      : {}),
    chars: sum('chars'),
    leftOut: summaries.flatMap((s) => s.leftOut),
  };
}
