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

// The pages of a space as a chat chooses from them (ADR-051): found by title, added alone or with
// every page under them, and described in a line that says how the chat will read them.

/** A page of the space, where it sits, and the ids of every page under it. */
export type SpacePage = { id: string; title: string; path: string; under: string[] };

/** Pages whose title matches what was typed, best first: titles that start with it, then those containing it. */
export function searchPages(pages: SpacePage[], query: string, limit = 8): SpacePage[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = pages.filter((p) => p.title.toLowerCase().startsWith(q));
  const contains = pages.filter((p) => !p.title.toLowerCase().startsWith(q) && p.title.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A chosen directory's name in the list of what a chat reads, such as "Runbooks + 14 sub-pages". */
export function directoryLabel(page: Pick<SpacePage, 'title' | 'under'>): string {
  return `${page.title} + ${plural(page.under.length, 'sub-page')}`;
}

/** How a chat will read its pages, from the server's count and whether they fit one request. */
export function readingLine(counts: {
  pages: number;
  fits?: boolean;
  indexing?: { done: number; total: number };
}): string {
  if (counts.indexing)
    return `Building the search index: ${counts.indexing.total ? Math.floor((counts.indexing.done / counts.indexing.total) * 100) : 0}% of ${plural(counts.indexing.total, 'page')}.`;
  if (counts.pages === 0) return 'No pages are chosen yet.';
  return counts.fits
    ? `${plural(counts.pages, 'page')}: each question reads all of them.`
    : `${plural(counts.pages, 'page')}: each question finds the sections it needs in them.`;
}
