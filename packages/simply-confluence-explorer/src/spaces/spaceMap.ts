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

// The Space map (design doc 0017): for each directory, how much sits below it, how old it is, and
// whether it is a series of near-identical pages such as one release note per build. It is worked
// out from the visible tree and the catalog each time it is read, so a page an exclusion rule hides
// is neither counted nor named.

import type { DirectoryStats, PageTreeNode } from '../api/types.js';
import type { CatalogEntry } from './catalog.js';

/** A directory whose newest page is older than this is marked stale. */
const STALE_DAYS = 365;
/** A series needs at least this many pages, and this share of the directory's pages. */
const SERIES_MIN = 5;
const SERIES_SHARE = 0.5;

/**
 * A title with its numbers, versions and dates replaced by `#`, so "Release 4.2.1 notes" and
 * "Release 5.0 notes" give the same key and "Runbook" gives itself.
 */
export function seriesKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/g, '#')
    .replace(/v?\d+([._\-/:]\d+)*[a-z]?\b/g, '#')
    .replace(/(#[\s\-–—_.,/()]*)+/g, '# ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The most common series among some titles, when it holds enough of them to count as one. */
export function seriesOf(titles: string[]): { pattern: string; pages: number } | undefined {
  const counts = new Map<string, number>();
  for (const t of titles) {
    const key = seriesKey(t);
    if (key.includes('#')) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [pattern, pages] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return pages >= SERIES_MIN && pages >= titles.length * SERIES_SHARE ? { pattern, pages } : undefined;
}

/** What a page and everything below it add to the directories above it. */
type Totals = { titles: string[]; size: number; newest: string; oldest: string; indexed: number; authors: Set<string> };

function absorb(into: Totals, from: Totals): void {
  into.titles.push(...from.titles);
  into.size += from.size;
  into.indexed += from.indexed;
  if (from.newest > into.newest) into.newest = from.newest;
  if (from.oldest && (!into.oldest || from.oldest < into.oldest)) into.oldest = from.oldest;
  for (const a of from.authors) into.authors.add(a);
}

function ownTotals(node: PageTreeNode, entry?: CatalogEntry): Totals {
  const modified = entry?.lastModified ?? node.lastModified ?? '';
  return {
    titles: [node.title],
    size: entry?.size ?? 0,
    newest: modified,
    oldest: modified,
    indexed: entry?.indexed ? 1 : 0,
    authors: new Set(entry?.author ? [entry.author] : []),
  };
}

function statsOf(node: PageTreeNode, path: string[], below: Totals, staleBefore: number): DirectoryStats {
  const pages = below.titles.length;
  const series = seriesOf(below.titles);
  return {
    id: node.id,
    title: node.title,
    path,
    pages,
    size: below.size,
    newest: below.newest,
    oldest: below.oldest,
    indexed: pages ? below.indexed / pages : 0,
    authors: below.authors.size,
    stale: !!below.newest && Date.parse(below.newest) < staleBefore,
    ...(series ? { series } : {}),
  };
}

/**
 * Every directory of a visible tree with what sits below it, largest first.
 *
 * @param roots The tree after exclusions (`SpaceStore.tree`).
 * @param entries The catalog, for each page's size, dates and index state.
 * @param now The time a page's age is measured from.
 */
export function directoryStats(
  roots: PageTreeNode[],
  entries: ReadonlyMap<string, CatalogEntry>,
  now = new Date(),
): DirectoryStats[] {
  const out: DirectoryStats[] = [];
  const staleBefore = now.getTime() - STALE_DAYS * 86_400_000;
  const walk = (node: PageTreeNode, path: string[]): Totals => {
    const below: Totals = { titles: [], size: 0, newest: '', oldest: '', indexed: 0, authors: new Set() };
    for (const child of node.children) absorb(below, walk(child, [...path, node.title]));
    if (node.children.length > 0) out.push(statsOf(node, path, below, staleBefore));
    absorb(below, ownTotals(node, entries.get(node.id)));
    return below;
  };
  for (const root of roots) walk(root, []);
  return out.sort((a, b) => b.pages - a.pages || a.title.localeCompare(b.title));
}
