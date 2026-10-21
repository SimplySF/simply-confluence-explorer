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

import crypto from 'node:crypto';
import type { BranchItem, PageChange, PagePart } from '../api/types.js';
import { RECORD_FIELDS, stripFrontmatter } from '../parser/convert.js';
import { blocksOf, diffBlocks, formBlocks, LINE_MARKER, MARKER, type EditForm } from '../parser/editForm.js';

// An edit of a page is reviewed change by change (ADR-059). The changes are the runs of blocks in
// which the working text differs from the page, worked out again whenever the text changes; a
// decision is kept by the change's content, so it survives an edit elsewhere on the page and is
// asked again of a change that was itself edited. Only accepted changes are ever written.

type Segment = { same: number } | { hunk: { id: string; removed: number[]; added: number[] } };

const wordsOf = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** How much of two blocks' wording they share, from 0 to 1. */
function likeness(a: string, b: string): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.max(1, Math.min(x.size, y.size));
}

/**
 * Splits a run of removed and added blocks into the changes a person decides on. A part standing
 * alone, such as a macro, is a change of its own, so removing it is decided apart from the text
 * around it. A run that replaces as many blocks of text as it removes is one change per block; in
 * any other run a removed block is paired with an added one that shares its wording, and the rest
 * are removals and additions of their own. The changes keep the order of both sides.
 */
function splitRun(removed: number[], added: number[], before: string[], after: string[]): Array<[number[], number[]]> {
  const lone = (text: string): boolean => LINE_MARKER.test(text.trim());
  const textR = removed.filter((i) => !lone(before[i]));
  const textA = added.filter((j) => !lone(after[j]));
  const pairs = new Map<number, number>();
  if (textR.length === textA.length) textR.forEach((r, k) => pairs.set(r, textA[k]));
  else {
    let from = 0;
    for (const r of textR) {
      const k = textA.findIndex((j, n) => n >= from && likeness(before[r], after[j]) >= 0.5);
      if (k < 0) continue;
      pairs.set(r, textA[k]);
      from = k + 1;
    }
  }
  const paired = new Set(pairs.values());
  const runs: Array<[number[], number[]]> = [];
  let j = 0;
  for (const r of removed) {
    const partner = pairs.get(r);
    if (partner === undefined) {
      runs.push([[r], []]);
      continue;
    }
    for (; j < added.length && added[j] !== partner; j++) if (!paired.has(added[j])) runs.push([[], [added[j]]]);
    runs.push([[r], [partner]]);
    j++;
  }
  for (; j < added.length; j++) if (!paired.has(added[j])) runs.push([[], [added[j]]]);
  return runs;
}

/** The page's text and the working text as blocks, in the order a push would write them. */
function segments(before: string[], after: string[]): Segment[] {
  const out: Segment[] = [];
  let removed: number[] = [];
  let added: number[] = [];
  const close = (at: number): void => {
    const runs = splitRun(removed, added, before, after);
    for (const [r, a] of runs) {
      const text = `${r[0] ?? at}\0${r.map((i) => before[i]).join('\n\n')}\0${a.map((i) => after[i]).join('\n\n')}`;
      const id = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
      out.push({ hunk: { id, removed: r, added: a } });
    }
    removed = [];
    added = [];
  };
  for (const op of diffBlocks(before, after)) {
    if (op.a !== undefined && op.b !== undefined) {
      close(op.a);
      out.push({ same: op.a });
    } else if (op.a !== undefined) removed.push(op.a);
    else added.push(op.b!);
  }
  close(before.length);
  return out;
}

const isBlock =
  (parts: PagePart[]) =>
  (n: number): boolean =>
    parts.some((p) => p.n === n && p.kind !== 'inline');
const markersIn = (text: string): number[] => [...text.matchAll(MARKER)].filter((m) => !m[1]).map((m) => Number(m[2]));

// A line naming one of the record's fields, as YAML, a list item or a table row.
const RECORD_LINE = new RegExp(
  `^[ \\t]*(?:[-*][ \\t]*|\\|[ \\t]*)?\\**(${RECORD_FIELDS.join('|')})\\**[ \\t]*[:|]`,
  'gim',
);
const DISTINCTIVE = new Set(['updatedat', 'confluenceurl', 'breadcrumbs']);

/**
 * Whether text holds the app's record of a page: two or more of its fields, one of them a field
 * ordinary page text would not have, so a configuration example with an `id:` line is not caught.
 */
export function holdsRecord(text: string): boolean {
  const fields = new Set([...text.matchAll(RECORD_LINE)].map((m) => m[1].toLowerCase()));
  return fields.size >= 2 && [...fields].some((f) => DISTINCTIVE.has(f));
}

/** What a person needs to know about the parts of the page a push of a page's text keeps or loses. */
export function partsOf(form: EditForm): { parts: PagePart[]; drops: Record<number, string[]> } {
  const { unitOf } = formBlocks(form);
  const drops: Record<number, string[]> = {};
  unitOf.forEach((u, i) => {
    if (form.units[u].drops.length > 0) drops[i] = form.units[u].drops;
  });
  return { parts: form.parts.map((p) => ({ n: p.n, label: p.label, kind: p.kind })), drops };
}

/** At most this much of what changed in a page is sent with a check of its suggestions. */
const CHANGED_CHARS = 8000;

/**
 * What changed in a page between two of its edit forms, as blocks added and removed, for the check
 * of suggestions made before the change (ADR-061).
 *
 * @param before The page's text when the suggestions were made, if this machine still has it.
 * @param after The page's text now.
 */
export function changedSince(before: string | undefined, after: string): string {
  if (before === undefined)
    return "(The page's earlier version is not on this machine; judge against the page as it is.)";
  const was = blocksOf(before, () => false);
  const now = blocksOf(after, () => false);
  const lines = segments(was, now).flatMap((s) =>
    'hunk' in s
      ? [...s.hunk.removed.map((i) => `Removed: ${was[i]}`), ...s.hunk.added.map((i) => `Added: ${now[i]}`)]
      : [],
  );
  const text = lines.join('\n\n') || '(Only formatting changed.)';
  return text.length > CHANGED_CHARS ? `${text.slice(0, CHANGED_CHARS)}\n(…cut)` : text;
}

/** The page's own text, without the frontmatter the model is shown with it. */
export const pageText = (item: BranchItem): string => stripFrontmatter(item.original ?? '');

/**
 * Works out an edit's changes from its working text, with each change's decision, what it removes
 * or drops, and whether it came from the model or the person, and sets the page's status from them.
 *
 * @param item The page in the run; its `changes`, `decisions` and `status` are updated.
 */
export function refreshChanges(item: BranchItem): void {
  const parts = item.parts ?? [];
  const block = isBlock(parts);
  const before = blocksOf(pageText(item), block);
  const working = item.proposed ?? '';
  const after = blocksOf(working, block);
  // A revision the chat proposed and the person accepted counts as the AI's, as its first edit does.
  const fromModel = new Set(
    [item.suggested ?? working, ...(item.refined ? [item.refined] : [])].flatMap((text) =>
      segments(before, blocksOf(text, block)).flatMap((s) => ('hunk' in s ? [s.hunk.id] : [])),
    ),
  );
  const kept = new Set(markersIn(working));
  const label = (n: number): string => `⟦${n} ${parts.find((p) => p.n === n)?.label ?? ''}⟧`;
  const decisions: Record<string, 'accepted' | 'rejected'> = {};
  item.changes = segments(before, after).flatMap((s): PageChange[] => {
    if (!('hunk' in s)) return [];
    const { id, removed, added } = s.hunk;
    const was = removed.map((i) => before[i]).join('\n\n');
    const now = added.map((i) => after[i]).join('\n\n');
    const notes = markersIn(was)
      .filter((n) => !kept.has(n))
      .map((n) => `Removes ${label(n)} from the page`);
    if (added.length > 0)
      for (const what of new Set(removed.flatMap((i) => item.drops?.[i] ?? [])))
        notes.push(`Rewriting this drops its ${what}, which the text cannot hold`);
    const unknown = markersIn(now).filter((n) => !parts.some((p) => p.n === n));
    const decision = item.decisions?.[id];
    if (decision) decisions[id] = decision;
    return [
      {
        id,
        before: was,
        after: now,
        source: fromModel.has(id) ? 'ai' : 'yours',
        notes,
        problem: unknown.length
          ? `${unknown.map((n) => `⟦${n}⟧`).join(', ')} is not a part of this page, so this change cannot be written.`
          : holdsRecord(now) && !holdsRecord(was)
            ? "This adds the app's record of the page (its id, version, author and the like), which is not text for the page, so it cannot be written."
            : undefined,
        decision: decision ?? 'pending',
      },
    ];
  });
  item.decisions = decisions;
  item.rows = segments(before, after).map((s) => ('same' in s ? { same: before[s.same] } : { change: s.hunk.id }));
  item.result = acceptedText(item).markdown;
  const settled = item.changes.length > 0 && item.changes.every((c) => c.decision !== 'pending');
  item.status = !settled ? 'proposed' : item.changes.some((c) => c.decision === 'accepted') ? 'accepted' : 'rejected';
}

/**
 * The text a push writes: the page with only the accepted changes applied, and the parts that
 * leaves out, which the person accepted removing.
 *
 * @param item The page in the run.
 */
export function acceptedText(item: BranchItem): { markdown: string; removes: number[] } {
  const block = isBlock(item.parts ?? []);
  const before = blocksOf(pageText(item), block);
  const after = blocksOf(item.proposed ?? '', block);
  const accepted = new Set((item.changes ?? []).filter((c) => c.decision === 'accepted').map((c) => c.id));
  const out = segments(before, after).flatMap((s) => {
    if ('same' in s) return [before[s.same]];
    return accepted.has(s.hunk.id) ? s.hunk.added.map((i) => after[i]) : s.hunk.removed.map((i) => before[i]);
  });
  const markdown = out.join('\n\n');
  const kept = new Set(markersIn(markdown));
  return { markdown, removes: markersIn(before.join('\n')).filter((n) => !kept.has(n)) };
}
