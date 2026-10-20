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

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

/**
 * A line-by-line diff (longest common subsequence). Pages are a few hundred lines; past `limit` lines
 * on either side the table would be large, so the two versions are shown as removed then added.
 *
 * @param before The current text.
 * @param after The proposed text.
 * @param limit The longest side that is diffed line by line.
 */
export function lineDiff(before: string, after: string, limit = 3000): DiffLine[] {
  return diffSeq(before.split('\n'), after.split('\n'), limit);
}

function diffSeq(a: string[], b: string[], limit: number): DiffLine[] {
  if (a.length > limit || b.length > limit) {
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ];
  }
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: 'removed', text: a[i++] });
    else out.push({ kind: 'added', text: b[j++] });
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] });
  while (j < b.length) out.push({ kind: 'added', text: b[j++] });
  return out;
}

export type WordPiece = { kind: 'same' | 'changed'; text: string };

/**
 * Marks the words that differ between two versions of a block, for each side, so a reworded
 * sentence shows which words changed rather than two whole lines.
 *
 * @param before The block as it was.
 * @param after The block as it will be.
 */
export function wordDiff(before: string, after: string): { before: WordPiece[]; after: WordPiece[] } {
  const out = { before: [] as WordPiece[], after: [] as WordPiece[] };
  const push = (side: WordPiece[], kind: WordPiece['kind'], text: string): void => {
    const last = side.at(-1);
    if (last?.kind === kind) last.text += text;
    else side.push({ kind, text });
  };
  for (const op of diffSeq(before.split(/(\s+)/), after.split(/(\s+)/), 4000)) {
    if (op.kind !== 'added') push(out.before, op.kind === 'same' ? 'same' : 'changed', op.text);
    if (op.kind !== 'removed') push(out.after, op.kind === 'same' ? 'same' : 'changed', op.text);
  }
  return out;
}
