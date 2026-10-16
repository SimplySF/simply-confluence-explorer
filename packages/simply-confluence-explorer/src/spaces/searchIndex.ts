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

import fs from 'node:fs';
import path from 'node:path';
import { parsePage } from '../parser/convert.js';
import type { SpaceStore } from './spaceStore.js';

// A keyword index over a space's synced pages (BM25), for finding pages that already say what a new
// page is meant to (ADR-025). Excluded pages are not indexed, because a search result is shown to the
// person and may be sent to an AI.

const STOP = new Set(
  'the and for with this that from your have will are was were has had not but you all can our out use how what when where which who why into about over under than then them they their there these those also any each such only more most some other'.split(
    ' ',
  ),
);

/**
 * Splits text into the lower-case words a search compares, without common words that match everything.
 *
 * @param text The text to split.
 */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 2 && !STOP.has(t));
}

type Doc = { pageId: string; title: string; excerpt: string; length: number; terms: Map<string, number> };
export type SearchHit = { pageId: string; title: string; excerpt: string; score: number };

// A word in the title says more about what a page is for than one in its body.
const TITLE_WEIGHT = 3;
const TAG_WEIGHT = 2;
const K1 = 1.2;
const B = 0.75;

function buildIndex(store: SpaceStore, spaceKey: string): { docs: Doc[]; df: Map<string, number>; avgLength: number } {
  const docs: Doc[] = [];
  const df = new Map<string, number>();
  for (const page of store.visiblePages(spaceKey)) {
    const meta = store.readMetadata(spaceKey, page.id);
    const body = parsePage(page).markdown.replace(/^---[\s\S]*?---\s*/, '');
    const terms = new Map<string, number>();
    const add = (text: string, weight: number): void =>
      tokens(text).forEach((t) => terms.set(t, (terms.get(t) ?? 0) + weight));
    add(page.title, TITLE_WEIGHT);
    add([...page.labels, ...(meta?.tags ?? [])].join(' '), TAG_WEIGHT);
    add(meta?.summary ?? '', 1);
    add(body, 1);
    const length = [...terms.values()].reduce((a, b) => a + b, 0);
    docs.push({
      pageId: page.id,
      title: page.title,
      excerpt: (meta?.summary ?? body).replace(/\s+/g, ' ').slice(0, 280),
      length,
      terms,
    });
    for (const t of terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { docs, df, avgLength: docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length) };
}

/** One index per space, rebuilt whenever the synced copy, its summaries or the exclusion rules change. */
export class SearchIndex {
  private readonly cache = new Map<string, { stamp: string; index: ReturnType<typeof buildIndex> }>();

  public constructor(private readonly store: SpaceStore) {}

  public search(spaceKey: string, query: string, limit = 8): SearchHit[] {
    if (!this.store.isSynced(spaceKey)) return [];
    const key = spaceKey.toUpperCase();
    const stamp = this.stamp(key);
    let entry = this.cache.get(key);
    if (entry?.stamp !== stamp) {
      entry = { stamp, index: buildIndex(this.store, key) };
      this.cache.set(key, entry);
    }
    const { docs, df, avgLength } = entry.index;
    const q = [...new Set(tokens(query))];
    const scored = docs
      .map((doc) => {
        let score = 0;
        for (const t of q) {
          const f = doc.terms.get(t);
          if (!f) continue;
          const n = df.get(t) ?? 0;
          const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
          score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / avgLength));
        }
        return { doc, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const top = scored[0]?.score ?? 1;
    return scored.map((r) => ({
      pageId: r.doc.pageId,
      title: r.doc.title,
      excerpt: r.doc.excerpt,
      score: Math.round((r.score / top) * 100) / 100,
    }));
  }

  // The newest file time in each directory, not the directory's own: rewriting a synced page in place,
  // as a push does, does not change the directory, and must still refresh the index.
  private stamp(spaceKey: string): string {
    const dir = this.store.spaceDir(spaceKey);
    const parts = ['pages_cache', 'metadata'].map((sub) => {
      const d = path.join(dir, sub);
      if (!fs.existsSync(d)) return '-';
      const files = fs.readdirSync(d);
      return `${files.length}:${Math.max(0, ...files.map((f) => fs.statSync(path.join(d, f)).mtimeMs))}`;
    });
    const rules = path.join(dir, '.confluenceignore');
    return [...parts, fs.existsSync(rules) ? fs.statSync(rules).mtimeMs : '-'].join('|');
  }
}
