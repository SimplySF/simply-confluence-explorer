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
import type { PageDetail, PageMetadata } from '../api/types.js';
import { splitSections, type Section } from './sections.js';
import type { SpaceStore } from './spaceStore.js';

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

type Doc = { section: Section; title: string; excerpt: string; length: number; terms: Map<string, number> };
export type SearchHit = { pageId: string; title: string; excerpt: string; score: number };
/** A section that matched, with the page it belongs to. */
export type SectionHit = { section: Section; title: string; score: number };

// A word in the title says more about what a page is for than one in its body, and a word in a
// section's heading says more about the section than one in its text.
const TITLE_WEIGHT = 3;
const TAG_WEIGHT = 2;
const HEADING_WEIGHT = 2;
const K1 = 1.2;
const B = 0.75;

type PageDocs = { stamp: string; docs: Doc[] };
type Index = { docs: Doc[]; df: Map<string, number>; avgLength: number };

/** One page's sections as search documents. Each carries its page's title, labels, tags, summary and questions. */
function pageDocs(page: PageDetail, meta?: PageMetadata): Doc[] {
  const sections = splitSections(page.id, parsePage(page).markdown);
  const pageTerms = new Map<string, number>();
  const add = (terms: Map<string, number>, text: string, weight: number): void =>
    tokens(text).forEach((t) => terms.set(t, (terms.get(t) ?? 0) + weight));
  add(pageTerms, page.title, TITLE_WEIGHT);
  add(pageTerms, [...page.labels, ...(meta?.tags ?? [])].join(' '), TAG_WEIGHT);
  add(pageTerms, [meta?.summary, ...(meta?.questions ?? [])].join(' '), 1);
  // A page with no text still has its title to be found by.
  const all = sections.length ? sections : [{ pageId: page.id, index: 0, path: [], text: '' }];
  return all.map((section) => {
    const terms = new Map(pageTerms);
    add(terms, section.path.join(' '), HEADING_WEIGHT);
    // The section's summary is matched to it by position, as the metadata was written from the same split.
    add(terms, `${meta?.sections?.[section.index]?.summary ?? ''} ${section.text}`, 1);
    return {
      section,
      title: page.title,
      excerpt: (meta?.summary ?? section.text).replace(/\s+/g, ' ').slice(0, 280),
      length: [...terms.values()].reduce((a, b) => a + b, 0),
      terms,
    };
  });
}

/**
 * A keyword index (BM25) over the sections of a space's synced pages (ADR-051). It finds the
 * sections a question needs, and the pages a new page might repeat (ADR-025). Excluded pages are not
 * indexed, because a search result is shown to the person and may be sent to an AI. A page is split
 * again only when its version or its metadata changes, so a large space is not re-read on every
 * change to one page.
 */
export class SearchIndex {
  private readonly cache = new Map<string, { stamp: string; index: Index }>();
  private readonly pages = new Map<string, PageDocs>();

  public constructor(private readonly store: SpaceStore) {}

  /** The pages that best match, each scored by its best section. */
  public search(spaceKey: string, query: string, limit = 8): SearchHit[] {
    const best = new Map<string, SearchHit>();
    for (const hit of this.rank(spaceKey, query)) {
      const id = hit.doc.section.pageId;
      if (!best.has(id)) best.set(id, { pageId: id, title: hit.doc.title, excerpt: hit.doc.excerpt, score: hit.score });
      if (best.size >= limit) break;
    }
    return normalised([...best.values()]);
  }

  /**
   * The sections that best match, optionally only from some pages.
   *
   * @param spaceKey The space.
   * @param query The words to look for.
   * @param limit How many sections to return.
   * @param within The pages to search, such as a chat's corpus; every page when absent.
   */
  public searchSections(spaceKey: string, query: string, limit: number, within?: Set<string>): SectionHit[] {
    return normalised(
      this.rank(spaceKey, query)
        .filter((hit) => !within || within.has(hit.doc.section.pageId))
        .slice(0, limit)
        .map((hit) => ({ section: hit.doc.section, title: hit.doc.title, score: hit.score })),
    );
  }

  /** A page's sections, from the index, so they are split once; empty for a page that is not indexed. */
  public sectionsOf(spaceKey: string, pageId: string): Section[] {
    this.indexFor(spaceKey.toUpperCase());
    return (this.pages.get(`${spaceKey.toUpperCase()}/${pageId}`)?.docs ?? [])
      .map((d) => d.section)
      .filter((s) => s.text);
  }

  private rank(spaceKey: string, query: string): Array<{ doc: Doc; score: number }> {
    if (!this.store.isSynced(spaceKey)) return [];
    const { docs, df, avgLength } = this.indexFor(spaceKey.toUpperCase());
    const q = [...new Set(tokens(query))];
    return docs
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
      .sort((a, b) => b.score - a.score);
  }

  private indexFor(key: string): Index {
    const stamp = this.stamp(key);
    let entry = this.cache.get(key);
    if (entry?.stamp !== stamp) {
      entry = { stamp, index: this.build(key) };
      this.cache.set(key, entry);
    }
    return entry.index;
  }

  private build(key: string): Index {
    const docs: Doc[] = [];
    const df = new Map<string, number>();
    const seen = new Set<string>();
    for (const page of this.store.visiblePages(key)) {
      const meta = this.store.readMetadata(key, page.id);
      const id = `${key}/${page.id}`;
      const pageStamp = `${page.version}|${page.storageXml.length}|${page.title}|${meta?.generatedAt ?? '-'}`;
      let cached = this.pages.get(id);
      if (cached?.stamp !== pageStamp) {
        cached = { stamp: pageStamp, docs: pageDocs(page, meta) };
        this.pages.set(id, cached);
      }
      seen.add(id);
      for (const doc of cached.docs) {
        docs.push(doc);
        for (const t of doc.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
    // A page that left the space, or is now excluded, is dropped from the cache too.
    for (const id of this.pages.keys()) if (id.startsWith(`${key}/`) && !seen.has(id)) this.pages.delete(id);
    return { docs, df, avgLength: docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length) };
  }

  // The store counts every change it makes to a space, so checking for changes costs nothing however
  // many pages a space has. The exclusion rules file is checked too, as it can be edited by hand.
  private stamp(spaceKey: string): string {
    const rules = path.join(this.store.spaceDir(spaceKey), '.confluenceignore');
    return `${this.store.revision(spaceKey)}|${fs.existsSync(rules) ? fs.statSync(rules).mtimeMs : '-'}`;
  }
}

/** Scores relative to the best match, so 1 is the best and the numbers read the same in any space. */
function normalised<T extends { score: number }>(hits: T[]): T[] {
  const top = hits[0]?.score ?? 1;
  return hits.map((h) => ({ ...h, score: Math.round((h.score / top) * 100) / 100 }));
}
