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

// A synced space's page catalog (ADR-064): for each page, the facts a list, a tree or the tags need,
// with its AI tags and summary, and none of its text. Whole-space views read it instead of every
// page's file, which on a large space is thousands of files. It is kept in memory and in
// catalog.json, changed by the store as pages and metadata are written, and built from the files
// once when missing, damaged, of an older format, or out of step with the pages on disk.

import fs from 'node:fs';
import type { PageDetail, PageMetadata } from '../api/types.js';
import { errorMessage } from '../util/errors.js';
import { mapChunked } from '../util/pause.js';
import { isCurrentMetadata } from './metadata.js';

/** One page in the catalog. It has what the exclusion rules, the tree and the tags read. */
export type CatalogEntry = Pick<
  PageDetail,
  'id' | 'title' | 'spaceKey' | 'parentId' | 'ancestors' | 'labels' | 'version' | 'author' | 'lastModified' | 'webUrl'
> & {
  /** The topic tags of its AI summary. */
  tags?: string[];
  summary?: string;
  documentType?: string;
  /** Its AI summary is of the current kind. */
  indexed?: boolean;
};

/** Bumped when an entry gains or loses a field, so a catalog written before is built again. */
const FORMAT = 1;
/** How long after a change the catalog is saved, so a sync or an index run saves it once. */
const SAVE_AFTER_MS = 1000;

export type CatalogSource = {
  file: (spaceKey: string) => string;
  ids: (spaceKey: string) => string[];
  readPage: (spaceKey: string, pageId: string) => PageDetail | undefined;
  readMetadata: (spaceKey: string, pageId: string) => PageMetadata | undefined;
  log: (message: string) => void;
};

/** A catalog entry from a page and its AI metadata. */
export function entryOf(page: PageDetail, metadata?: PageMetadata): CatalogEntry {
  const { id, title, spaceKey, parentId, ancestors, labels, version, author, lastModified, webUrl } = page;
  return {
    id,
    title,
    spaceKey,
    parentId,
    ancestors: ancestors.map((a) => ({ id: a.id, title: a.title })),
    labels,
    version,
    author,
    lastModified,
    webUrl,
    ...(metadata ? withMetadata(metadata) : {}),
  };
}

const withMetadata = (m: PageMetadata): Partial<CatalogEntry> => ({
  tags: m.tags,
  summary: m.summary,
  documentType: m.documentType,
  indexed: isCurrentMetadata(m),
});

export class SpaceCatalog {
  private readonly spaces = new Map<string, Map<string, CatalogEntry>>();
  private readonly builds = new Map<string, { done: number; total: number; promise: Promise<void> }>();
  private readonly saves = new Map<string, NodeJS.Timeout>();

  public constructor(private readonly source: CatalogSource) {}

  /** The space's catalog, loaded from its file or built from the pages once. */
  public async ready(spaceKey: string): Promise<Map<string, CatalogEntry>> {
    const loaded = this.load(spaceKey);
    if (loaded) return loaded;
    await this.build(spaceKey);
    return this.spaces.get(spaceKey) ?? new Map();
  }

  /**
   * The space's catalog at once: loaded from its file, or built from the pages in one go. Code that
   * cannot wait, such as a tree asked for before any whole-space work, uses this; the rest awaits
   * `ready`, which lets other requests through while it builds.
   */
  public now(spaceKey: string): Map<string, CatalogEntry> {
    const loaded = this.load(spaceKey);
    if (loaded) return loaded;
    const pages = new Map(
      this.source
        .ids(spaceKey)
        .flatMap((id) => this.entry(spaceKey, id) ?? [])
        .map((e) => [e.id, e]),
    );
    this.spaces.set(spaceKey, pages);
    this.save(spaceKey);
    return pages;
  }

  /**
   * How far a first build has got, starting it when the catalog is neither in memory nor on disk;
   * `undefined` once the catalog can be read at once.
   */
  public progress(spaceKey: string): { done: number; total: number } | undefined {
    if (this.load(spaceKey)) return undefined;
    void this.build(spaceKey);
    const b = this.builds.get(spaceKey);
    return b ? { done: b.done, total: b.total } : undefined;
  }

  /** The builds running now, for the header's list of background work. */
  public building(): Array<{ spaceKey: string; done: number; total: number }> {
    return [...this.builds].map(([spaceKey, b]) => ({ spaceKey, done: b.done, total: b.total }));
  }

  /** Records a page as written; a newer version has no AI summary until it is indexed again. */
  public put(spaceKey: string, page: PageDetail): void {
    this.change(spaceKey, (pages) => pages.set(page.id, entryOf(page)));
  }

  public setMetadata(spaceKey: string, metadata: PageMetadata): void {
    this.change(spaceKey, (pages) => {
      const entry = pages.get(metadata.pageId);
      if (entry) pages.set(metadata.pageId, { ...entry, ...withMetadata(metadata) });
    });
  }

  public remove(spaceKey: string, pageId: string): void {
    this.change(spaceKey, (pages) => pages.delete(pageId));
  }

  /** Writes a space's catalog now, as at the end of a burst of changes. */
  public save(spaceKey: string): void {
    clearTimeout(this.saves.get(spaceKey));
    this.saves.delete(spaceKey);
    const pages = this.spaces.get(spaceKey);
    if (!pages) return;
    const file = this.source.file(spaceKey);
    // Written beside it and moved into place, so a reader never finds half a file.
    const saved = { format: FORMAT, files: this.source.ids(spaceKey).length, pages: [...pages.values()] };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(saved), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  }

  /**
   * Applies a change to a catalog in memory, and saves it soon after. Until it is saved, the file
   * on disk is removed, so an app stopped in between builds the catalog again rather than trusting
   * an old one. A catalog not in memory is only removed from disk, to be built when next read.
   */
  private change(spaceKey: string, apply: (pages: Map<string, CatalogEntry>) => void): void {
    const pages = this.spaces.get(spaceKey);
    fs.rmSync(this.source.file(spaceKey), { force: true });
    if (!pages) return;
    apply(pages);
    if (this.saves.has(spaceKey)) return;
    const timer = setTimeout(() => this.save(spaceKey), SAVE_AFTER_MS);
    timer.unref();
    this.saves.set(spaceKey, timer);
  }

  /** The catalog in memory, or read from its file when that is whole, current and complete. */
  private load(spaceKey: string): Map<string, CatalogEntry> | undefined {
    const inMemory = this.spaces.get(spaceKey);
    if (inMemory) return inMemory;
    const file = this.source.file(spaceKey);
    if (!fs.existsSync(file)) return undefined;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        format?: number;
        files?: number;
        pages?: CatalogEntry[];
      };
      if (saved.format !== FORMAT || !Array.isArray(saved.pages)) return undefined;
      // Page files added or removed by anything but this store mean the catalog no longer matches.
      if (saved.files !== this.source.ids(spaceKey).length) return undefined;
      const pages = new Map(saved.pages.map((p) => [p.id, p]));
      this.spaces.set(spaceKey, pages);
      return pages;
    } catch {
      // A damaged file is built again from the pages, which are the source of truth.
      return undefined;
    }
  }

  /** A page's entry, read from its files; a damaged page file is left out, as it is from the tree. */
  private entry(spaceKey: string, id: string): CatalogEntry | undefined {
    try {
      const page = this.source.readPage(spaceKey, id);
      return page ? entryOf(page, this.source.readMetadata(spaceKey, id)) : undefined;
    } catch (error) {
      this.source.log(`cannot read the synced copy of page ${id} in ${spaceKey}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** Builds a space's catalog from its page files, once however many ask, a chunk at a time. */
  private build(spaceKey: string): Promise<void> {
    const running = this.builds.get(spaceKey);
    if (running) return running.promise;
    const ids = this.source.ids(spaceKey);
    const progress = { done: 0, total: ids.length, promise: Promise.resolve() };
    progress.promise = (async (): Promise<void> => {
      try {
        const entries = await mapChunked(ids, (id) => {
          progress.done++;
          return this.entry(spaceKey, id);
        });
        this.spaces.set(spaceKey, new Map(entries.flatMap((e) => (e ? [[e.id, e] as const] : []))));
        this.save(spaceKey);
      } finally {
        this.builds.delete(spaceKey);
      }
    })();
    this.builds.set(spaceKey, progress);
    return progress.promise;
  }
}
