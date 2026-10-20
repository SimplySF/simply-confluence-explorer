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

export type ContextKind = 'page' | 'section' | 'file' | 'turn';
export type LeftOutReason = 'excluded' | 'secret' | 'over-limit' | 'history-limit';

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
};

export type ContextManifest = { items: ManifestItem[] };

/** What an answer shows under What was sent: counts and sizes, and each item left out with why. */
export type ManifestSummary = {
  pages: number;
  sections: number;
  files: number;
  turns: number;
  chars: number;
  leftOut: Array<{ kind: ContextKind; label: string; reason: LeftOutReason | 'cut' }>;
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

  public leaveOut(kind: ContextKind, label: string, chars: number, reason: LeftOutReason): void {
    this.items.push({ kind, label: reason === 'excluded' ? '' : label, chars, included: false, reason });
  }

  public build(): ContextManifest {
    return { items: [...this.items] };
  }
}

/**
 * The problems with a payload: each included item whose marker is missing, or whose text after the
 * marker is much shorter than the item, as when it was cut on its way. The guard may replace a value
 * with a placeholder of a different length, so a small difference is allowed.
 *
 * @param manifest What the request was built to carry.
 * @param payload Everything the request will send, as one string.
 */
export function checkPayload(manifest: ContextManifest, payload: string): string[] {
  const marked = manifest.items.filter((i) => i.included && i.marker);
  const positions = marked.map((i) => payload.indexOf(i.marker!));
  const problems: string[] = [];
  marked.forEach((item, n) => {
    const at = positions[n];
    const name = item.label || `an item of kind ${item.kind}`;
    if (at < 0) {
      problems.push(`${name} is missing`);
      return;
    }
    const following = positions.filter((p) => p > at);
    const end = following.length ? Math.min(...following) : payload.length;
    const carried = end - at - item.marker!.length - 1;
    if (carried < item.chars * 0.8 - 100)
      problems.push(`${name} arrived with ${carried} of its ${item.chars} characters`);
  });
  return problems;
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
    chars: sent.reduce((n, i) => n + i.chars, 0),
    leftOut: [
      ...manifest.items.filter((i) => !i.included).map((i) => ({ kind: i.kind, label: i.label, reason: i.reason! })),
      ...sent.filter((i) => i.cut).map((i) => ({ kind: i.kind, label: i.label, reason: 'cut' as const })),
    ],
  };
}
