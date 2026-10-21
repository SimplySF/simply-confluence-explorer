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
import { frontmatterOf } from '../parser/convert.js';
import type { PageDetail, PageMetadata } from '../api/types.js';
import { mapChunked } from '../util/pause.js';
import { splitSections, type Section } from './sections.js';
import type { SpaceStore } from './spaceStore.js';

const STOP = new Set(
  'the and for with this that from your have will are was were has had not but you all can our out use how what when where which who why into about over under than then them they their there these those also any each such only more most some other'.split(
    ' ',
  ),
);

/**
 * A word reduced to a common stem, so "rolled", "rolling" and "rolls" all compare as "roll", and
 * "billed" finds "billing". It is a small set of English suffix rules rather than a full stemmer: a
 * search only needs the same word in different forms to meet, not a correct root.
 *
 * @param word A lower-case word.
 */
export function stem(word: string): string {
  let w = word.length > 4 && word.endsWith('ies') ? `${word.slice(0, -3)}y` : word;
  for (const suffix of ['ing', 'ed', 'es', 's', 'ly']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  if (w.endsWith('ie')) w = `${w.slice(0, -2)}y`;
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  // A doubled last letter, as in "stopped" or "billing", meets the single one, as in "stop" or "bill".
  if (w.length > 3 && w.at(-1) === w.at(-2) && !/[aeiou]/.test(w.at(-1)!)) w = w.slice(0, -1);
  return w;
}

/**
 * Splits text into the stems of the lower-case words a search compares, without common words that
 * match everything.
 *
 * @param text The text to split.
 */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 2 && !STOP.has(t))
    .map(stem);
}

type Doc = { section: Section; title: string; excerpt: string; length: number; terms: Map<string, number> };
export type SearchHit = { pageId: string; title: string; excerpt: string; score: number };
/** A section that matched, with the page it belongs to. */
/** A section that matched, with the page it belongs to and the share of the question's words it holds. */
export type SectionHit = { section: Section; title: string; score: number; covers: number };

// A word in the title says more about what a page is for than one in its body, and a word in a
// section's heading says more about the section than one in its text.
const TITLE_WEIGHT = 3;
const TAG_WEIGHT = 2;
const HEADING_WEIGHT = 2;
const K1 = 1.2;
const B = 0.75;

type PageDocs = { stamp: string; docs: Doc[]; size: number };
type Index = { docs: Doc[]; df: Map<string, number>; avgLength: number };
const EMPTY: Index = { docs: [], df: new Map(), avgLength: 0 };

/** One page's sections as search documents. Each carries its page's title, labels, tags, summary and questions. */
function pageDocs(page: PageDetail, sections: Section[], meta?: PageMetadata): Doc[] {
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
  // Converting a page to sections is the slow part, so it is kept per page version, apart from the
  // search documents, which a new summary changes.
  private readonly split = new Map<string, { stamp: string; sections: Section[] }>();
  private readonly builds = new Map<string, { done: number; total: number; promise: Promise<void> }>();

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
        .map((hit) => ({ section: hit.doc.section, title: hit.doc.title, score: hit.score, covers: hit.covers })),
    );
  }

  /** A page's sections, from the index, so they are split once; empty for a page that is not indexed. */
  public sectionsOf(spaceKey: string, pageId: string): Section[] {
    this.indexFor(spaceKey.toUpperCase());
    return (this.pages.get(`${spaceKey.toUpperCase()}/${pageId}`)?.docs ?? [])
      .map((d) => d.section)
      .filter((s) => s.text);
  }

  /**
   * Resolves when a space's index is up to date, building it first if not. The build reads the pages
   * in small chunks and lets other requests through between them, so a large space never stops the
   * server answering while it is indexed.
   */
  public ready(spaceKey: string): Promise<void> {
    const key = spaceKey.toUpperCase();
    const running = this.builds.get(key);
    if (running) return running.promise;
    if (!this.store.isSynced(key) || this.cache.get(key)?.stamp === this.stamp(key)) return Promise.resolve();
    const build = { done: 0, total: 0, promise: Promise.resolve() };
    build.promise = this.warm(key, build).finally(() => this.builds.delete(key));
    this.builds.set(key, build);
    return build.promise;
  }

  /** About how many characters reading these pages in full would take, from what the index has kept. */
  public sizeOf(spaceKey: string, pages: PageDetail[]): number {
    const key = spaceKey.toUpperCase();
    this.indexFor(key);
    return pages.reduce((n, p) => n + (this.pages.get(`${key}/${p.id}`)?.size ?? 0), 0);
  }

  /** The builds under way, with how far each has got. */
  public building(): Array<{ spaceKey: string; done: number; total: number }> {
    return [...this.builds].map(([spaceKey, b]) => ({ spaceKey, done: b.done, total: b.total }));
  }

  private rank(spaceKey: string, query: string): Array<{ doc: Doc; score: number; covers: number }> {
    if (!this.store.isSynced(spaceKey)) return [];
    const { docs, df, avgLength } = this.indexFor(spaceKey.toUpperCase());
    const q = [...new Set(tokens(query))];
    return docs
      .map((doc) => {
        let score = 0;
        let found = 0;
        for (const t of q) {
          const f = doc.terms.get(t);
          if (!f) continue;
          found++;
          const n = df.get(t) ?? 0;
          const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
          score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / avgLength));
        }
        return { doc, score, covers: q.length ? found / q.length : 0 };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  private async warm(key: string, progress: { done: number; total: number }): Promise<void> {
    const stamp = this.stamp(key);
    const pages = await this.store.visiblePages(key);
    progress.total = pages.length;
    const docs: Doc[] = [];
    const df = new Map<string, number>();
    const seen = new Set<string>();
    await mapChunked(pages, (page) => {
      seen.add(`${key}/${page.id}`);
      for (const doc of this.docsFor(key, page)) {
        docs.push(doc);
        for (const t of doc.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      }
      progress.done++;
    });
    // A page that left the space, or is now excluded, is dropped from the cache too.
    for (const cache of [this.pages, this.split])
      for (const id of cache.keys()) if (id.startsWith(`${key}/`) && !seen.has(id)) cache.delete(id);
    const avgLength = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);
    this.cache.set(key, { stamp, index: { docs, df, avgLength } });
  }

  private docsFor(key: string, page: PageDetail): Doc[] {
    const meta = this.store.readMetadata(key, page.id);
    const id = `${key}/${page.id}`;
    const pageStamp = `${page.version}|${page.storageXml.length}|${page.title}|${meta?.generatedAt ?? '-'}`;
    let cached = this.pages.get(id);
    if (cached?.stamp !== pageStamp) {
      const attached = page.attachments.map((a) => `${a.title}:${a.fileSize}`).join(',');
      const splitStamp = `${page.version}|${page.storageXml.length}|${attached}`;
      let split = this.split.get(id);
      if (split?.stamp !== splitStamp) {
        // Text attachments are sections of their page, so a question finds a value only they hold.
        split = { stamp: splitStamp, sections: splitSections(page.id, this.store.readableMarkdown(key, page)) };
        this.split.set(id, split);
      }
      // About how many characters the page takes when read in full: its frontmatter and each section with its heading.
      const size = frontmatterOf(page).length + split.sections.reduce((n, s) => n + s.text.length + 20, 0);
      cached = { stamp: pageStamp, docs: pageDocs(page, split.sections, meta), size };
      this.pages.set(id, cached);
    }
    return cached.docs;
  }

  /**
   * The index as last built. It is never built here, on a request's path: every search a person
   * waits on awaits `ready` first, so a stale index is read only when a write lands in between, and a
   * rebuild is started. After a change to the exclusion rules nothing is read until the rebuild, so an
   * excluded page is never found.
   */
  private indexFor(key: string): Index {
    const stamp = this.stamp(key);
    const entry = this.cache.get(key);
    if (entry?.stamp === stamp) return entry.index;
    void this.ready(key);
    const rulesOf = (s: string): string => s.split('|')[1];
    return entry && rulesOf(entry.stamp) === rulesOf(stamp) ? entry.index : EMPTY;
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
