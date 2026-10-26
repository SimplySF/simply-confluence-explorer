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
import type { PageDetail, PageMetadata, PageTreeNode, SpaceTocNode, SyncedSpace } from '../api/types.js';
import { parsePage } from '../parser/convert.js';
import { mapChunked } from '../util/pause.js';
import { sanitizeFilename, within } from '../util/paths.js';
import type { PageVectors } from './vectors.js';
import { AttachmentReader, type AttachmentFile, type Extract } from './attachments.js';
import { SpaceCatalog, type CatalogEntry } from './catalog.js';
import type { ExclusionManager } from './exclusionManager.js';
import { tagsOf } from './tags.js';

// A synced space lives in `<data dir>/spaces/<KEY>/`:
//
//   pages_cache/<id>.json   each page as read from Confluence, which the app reads back
//   pages/.../<Title>.md    the same pages as Markdown, in folders that follow the page tree
//   pages/.../<Title>_attachments/   each page's attachments
//   metadata/<id>.json      AI summaries and tags, written by the metadata run
//   vectors/<id>.json       each section's embedding, when the AI provider makes them (ADR-051)
//   manifest.json           when the space was synced and from which page
//   catalog.json            each page's title, place, labels and AI tags, without its text (ADR-064)
//   toc.json, TOC.md        the table of contents
//
// pages/ is for people: they may read it, zip it, or delete a folder from it. The app reads
// pages_cache/, and purging reconciles the two.

type Manifest = Omit<SyncedSpace, 'metadataCount' | 'hasTOC'>;

/** A space's own rules and choices, which outlive its copy (deleteSpace). */
const KEPT_ON_DELETE = new Set(['.confluenceignore', '.confluenceguard', '.confluencespace.json']);

/**
 * The store as a chat sees it: every page read without its attachments when the chat reads pages
 * only, or without those the person left out (ADR-069). Everything else is the store itself.
 *
 * @param store The space store.
 * @param attachments False for pages only, or the files left out, by `fileKey`.
 */
export function storeFor<T extends Pick<SpaceStore, 'readableMarkdown'>>(
  store: T,
  attachments: false | ReadonlySet<string>,
): T {
  return new Proxy(store, {
    get(target, prop, receiver): unknown {
      if (prop === 'readableMarkdown')
        return (spaceKey: string, page: PageDetail): string => target.readableMarkdown(spaceKey, page, attachments);
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export class SpaceStore {
  /** Each space's page catalog, which whole-space views read instead of every page's file. */
  public readonly catalog: SpaceCatalog;
  /** Reads a synced page's attachments for the AI (ADR-066). */
  public readonly attachments: AttachmentReader;
  private readonly spacesDir: string;
  // Built from pages_cache once per change, because a large space has thousands of files.
  private readonly trees = new Map<string, { roots: PageTreeNode[]; byId: Map<string, PageTreeNode> }>();
  // A count of the changes made to each space through this store, so the search index can tell it is
  // out of date without looking at every file in a space of thousands of pages.
  private readonly revisions = new Map<string, number>();
  // Metadata already read, by file, with the file time it was read at (readMetadata).
  private readonly metadataRead = new Map<string, { mtimeMs: number; metadata: PageMetadata }>();
  // The ids of a space's synced pages, listed again only when the folder changes: a folder's time
  // changes whenever a file is added to it or removed, so one look at it replaces listing thousands of
  // files, and a change made outside the app is still seen.
  private readonly idsListed = new Map<string, { mtimeMs: number; revision: number; ids: string[] }>();
  // Each page's attachments as last listed, until its folder or the store changes (attachmentEntries).
  private readonly attachmentsListed = new Map<string, { stamp: string; entries: AttachmentFile[] }>();

  public constructor(
    dataDir: string,
    private readonly exclusions: ExclusionManager,
    log: (message: string) => void,
    extract?: Extract,
  ) {
    this.spacesDir = path.join(dataDir, 'spaces');
    this.catalog = new SpaceCatalog({
      file: (key): string => path.join(this.spaceDir(key), 'catalog.json'),
      ids: (key): string[] => this.cachedIds(key),
      readPage: (key, id): PageDetail | undefined => this.readPage(key, id),
      readMetadata: (key, id): PageMetadata | undefined => this.readMetadata(key, id),
      log,
    });
    this.attachments = new AttachmentReader(
      (key, page) => this.attachmentEntries(key, page),
      log,
      (key) => this.isSynced(key),
      extract,
    );
  }

  public spaceDir(spaceKey: string): string {
    return within(this.spacesDir, sanitizeFilename(spaceKey.trim().toUpperCase()));
  }

  public isSynced(spaceKey: string): boolean {
    return this.cachedIds(spaceKey).length > 0;
  }

  /** A synced page, or `undefined` when it is not on disk. */
  public readPage(spaceKey: string, pageId: string): PageDetail | undefined {
    const file = this.cacheFile(spaceKey, pageId);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PageDetail;
  }

  /**
   * A page's Markdown as the AI reads it: its text, then the text of its text attachments as
   * sections of their own (ADR-066), unless a chat reads pages only (ADR-069).
   */
  public readableMarkdown(
    spaceKey: string,
    page: PageDetail,
    attachments: boolean | ReadonlySet<string> = true,
  ): string {
    const markdown = parsePage(page).markdown;
    if (attachments === false) return markdown;
    const skip = attachments === true ? undefined : attachments;
    return `${markdown}${this.attachments.of(spaceKey.toUpperCase(), page, skip).text}`;
  }

  /** The synced space a page belongs to, when the caller does not know it. */
  public findSpaceKey(pageId: string): string | undefined {
    return this.spaceKeys().find((key) => fs.existsSync(this.cacheFile(key, pageId)));
  }

  /**
   * Writes a page's cached copy, its Markdown and its attachments. The attachment folder is kept in
   * step with the page: a file the page no longer has is removed. Without `attachments`, as when a
   * page is read again after a push, the files on disk are kept.
   */
  public writePage(
    spaceKey: string,
    page: PageDetail,
    markdown: string,
    attachments?: Array<{ name: string; data: Buffer }>,
  ): void {
    const cacheFile = this.cacheFile(spaceKey, page.id);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const mdFile = this.markdownFile(spaceKey, page);
    fs.mkdirSync(path.dirname(mdFile), { recursive: true });
    fs.writeFileSync(mdFile, markdown, 'utf8');
    if (attachments) {
      const dir = this.attachmentsDir(spaceKey, page);
      const names = attachmentFileNames(attachments.map((a) => a.name));
      if (fs.existsSync(dir))
        for (const old of fs.readdirSync(dir)) if (!names.includes(old)) fs.rmSync(within(dir, old), { force: true });
      if (attachments.length > 0) fs.mkdirSync(dir, { recursive: true });
      attachments.forEach((a, i) => fs.writeFileSync(within(dir, names[i]), a.data));
      if (attachments.length === 0) fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.writeFileSync(cacheFile, JSON.stringify(page, null, 2), 'utf8');
    // A newer version makes the old summary, tags and embeddings stale.
    fs.rmSync(this.metadataFile(spaceKey, page.id), { force: true });
    fs.rmSync(this.vectorsFile(spaceKey, page.id), { force: true });
    this.catalog.put(spaceKey.toUpperCase(), page);
    this.invalidate(spaceKey);
  }

  /** Replaces a synced page's copy with the page as Confluence now holds it, keeping its attachments. */
  public refreshPage(spaceKey: string, page: PageDetail): void {
    this.writePage(spaceKey, page, parsePage(page).markdown);
  }

  /**
   * A synced page's attachment files on disk, each with its title and type as Confluence gave them.
   * Only files the page still lists are named.
   */
  public attachmentFiles(
    spaceKey: string,
    page: PageDetail,
  ): Array<{ title: string; mediaType: string; file: string; bytes: number }> {
    return this.attachmentEntries(spaceKey, page).filter((a) => !a.missing);
  }

  /** Every attachment a page lists, each marked missing when its file is not on this machine. */
  public attachmentEntries(spaceKey: string, page: PageDetail): AttachmentFile[] {
    if (page.attachments.length === 0) return [];
    const dir = this.attachmentsDir(spaceKey, page);
    // Kept until the page's folder or the store changes, so a page asked about again costs one look
    // at its folder rather than one for each of its files.
    const folder = fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? -1;
    const stamp = `${this.revision(spaceKey)}|${folder}|${page.version}`;
    const id = `${spaceKey.toUpperCase()}/${page.id}`;
    const kept = this.attachmentsListed.get(id);
    if (kept?.stamp === stamp) return kept.entries;
    const entries = listAttachments(dir, page);
    this.attachmentsListed.set(id, { stamp, entries });
    return entries;
  }

  /** The version of a page on disk, or 0 when it is not synced. */
  public cachedVersion(spaceKey: string, pageId: string): number {
    return this.readPage(spaceKey, pageId)?.version ?? 0;
  }

  /** The synced tree, without excluded pages or anything below them. */
  public tree(spaceKey: string, rootPageId?: string): PageTreeNode[] {
    const { roots, byId } = this.loadTree(spaceKey);
    if (!rootPageId) return roots;
    const root = byId.get(rootPageId);
    return root ? [root] : [];
  }

  /** Every visible synced page below a page. */
  public descendants(spaceKey: string, pageId: string): PageTreeNode[] {
    const root = this.loadTree(spaceKey).byId.get(pageId);
    const all = (nodes: PageTreeNode[]): PageTreeNode[] => nodes.flatMap((n) => [n, ...all(n.children)]);
    return root ? all(root.children) : [];
  }

  public writeManifest(spaceKey: string, manifest: Manifest): void {
    fs.writeFileSync(path.join(this.spaceDir(spaceKey), 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }

  /** The synced spaces. Each space's summaries are read in chunks, as a large space has thousands. */
  public async listSynced(): Promise<SyncedSpace[]> {
    const spaces: SyncedSpace[] = [];
    for (const key of this.spaceKeys()) {
      const dir = this.spaceDir(key);
      const file = path.join(dir, 'manifest.json');
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
      // Only metadata of the current kind counts, so the Space menu offers to redo the rest.
      // eslint-disable-next-line no-await-in-loop -- one space at a time
      const pages = await this.catalog.ready(key.toUpperCase());
      spaces.push({
        ...manifest,
        pageCount: this.cachedIds(key).length,
        metadataCount: [...pages.values()].filter((p) => p.indexed).length,
        hasTOC: fs.existsSync(path.join(dir, 'toc.json')),
      });
    }
    return spaces;
  }

  /**
   * Deletes the synced copies of pages that are now excluded, or whose Markdown file a person
   * deleted from pages/, and rebuilds the table of contents.
   */
  public async purgeStale(spaceKey: string): Promise<{ purgedCount: number; remainingPages: number }> {
    const excluded = this.exclusions.checker(spaceKey);
    const stale = this.cachedIds(spaceKey).filter((id) => {
      const page = this.readPage(spaceKey, id);
      return !page || excluded(page) || !fs.existsSync(this.markdownFile(spaceKey, page));
    });
    for (const id of stale) this.removePage(spaceKey, id, false);
    await this.afterRemoval(spaceKey);
    return { purgedCount: stale.length, remainingPages: this.cachedIds(spaceKey).length };
  }

  /**
   * Deletes a space's copy on this machine: its pages and attachments, AI index, embeddings, table
   * of contents and catalog. Its exclusion and leak-guard rules and its image choice are kept, so a
   * later sync of the space is held to the same rules, and chats about it are kept too.
   */
  public deleteSpace(spaceKey: string): { deletedPages: number } {
    const key = spaceKey.trim().toUpperCase();
    const dir = this.spaceDir(key);
    const deletedPages = this.cachedIds(key).length;
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      if (!KEPT_ON_DELETE.has(name)) fs.rmSync(within(dir, name), { recursive: true, force: true });
    this.catalog.forget(key);
    this.invalidate(key);
    return { deletedPages };
  }

  /**
   * Deletes one synced page, and optionally everything below it, from this machine. With
   * `addToIgnore`, rules are added so the next sync does not bring it back.
   */
  public async purgePage(
    spaceKey: string,
    pageId: string,
    options: { includeSubPages: boolean; addToIgnore: boolean },
  ): Promise<{ purgedCount: number }> {
    const page = this.readPage(spaceKey, pageId);
    if (!page) return { purgedCount: 0 };
    if (options.includeSubPages) await this.treeReady(spaceKey);
    const ids = [pageId, ...(options.includeSubPages ? this.descendants(spaceKey, pageId).map((d) => d.id) : [])];
    if (options.addToIgnore) {
      const rules = options.includeSubPages ? [`${page.title}/`, `*${page.title}*`] : [page.title, `id:${page.id}`];
      this.exclusions.savePatterns(spaceKey, [...new Set([...this.exclusions.patterns(spaceKey), ...rules])]);
    }
    for (const id of ids) this.removePage(spaceKey, id, options.includeSubPages);
    await this.afterRemoval(spaceKey);
    return { purgedCount: ids.length };
  }

  /** Where a page's Markdown goes, in folders named after its ancestors. */
  public markdownFile(spaceKey: string, page: Pick<PageDetail, 'title' | 'ancestors'>): string {
    return within(
      this.pagesDir(spaceKey),
      ...page.ancestors.map((a) => sanitizeFilename(a.title)),
      `${sanitizeFilename(page.title)}.md`,
    );
  }

  /**
   * The table of contents, built from the visible synced pages and any AI summaries. Every page and
   * summary is read in chunks, so a large space does not hold the server while it is built.
   */
  public async buildToc(spaceKey: string): Promise<SpaceTocNode[]> {
    await this.treeReady(spaceKey);
    const pages = await this.catalog.ready(spaceKey.toUpperCase());
    const toNode = (node: PageTreeNode): SpaceTocNode => {
      const page = pages.get(node.id);
      return {
        id: node.id,
        title: node.title,
        path: page
          ? path.relative(this.pagesDir(spaceKey), this.markdownFile(spaceKey, page)).split(path.sep).join('/')
          : '',
        summary: page?.summary,
        tags: page ? tagsOf(page, page) : [],
        documentType: page?.documentType,
        children: node.children.map(toNode),
      };
    };
    return this.tree(spaceKey).map(toNode);
  }

  /** Writes toc.json, and TOC.md for people browsing the folder, for a synced space. */
  public async writeToc(spaceKey: string): Promise<SpaceTocNode[]> {
    const toc = await this.buildToc(spaceKey);
    const dir = this.spaceDir(spaceKey);
    const lines = [`# Table of contents: ${spaceKey.toUpperCase()}`, ''];
    const render = (nodes: SpaceTocNode[], depth: number): void => {
      for (const n of nodes) {
        const indent = '  '.repeat(depth);
        lines.push(`${indent}- [${n.title}](./pages/${encodeURI(n.path)})`);
        if (n.summary) lines.push(`${indent}  > ${n.summary}`);
        render(n.children, depth + 1);
      }
    };
    render(toc, 0);
    fs.writeFileSync(path.join(dir, 'toc.json'), JSON.stringify(toc, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'TOC.md'), `${lines.join('\n')}\n`, 'utf8');
    return toc;
  }

  /**
   * The files that go into a space's ZIP: the Markdown and attachments of every page that is not
   * excluded, the table of contents and the manifest. The rules are applied here as well as at sync
   * time, because a rule saved without purging leaves excluded copies on disk.
   */
  public zipEntries(spaceKey: string): Array<{ file: string; name: string }> {
    const dir = this.spaceDir(spaceKey);
    const entries: Array<{ file: string; name: string }> = [];
    const add = (file: string): void => {
      if (fs.existsSync(file)) entries.push({ file, name: path.relative(dir, file).split(path.sep).join('/') });
    };
    const excluded = this.exclusions.checker(spaceKey);
    for (const id of this.cachedIds(spaceKey)) {
      const page = this.readPage(spaceKey, id);
      if (!page || excluded(page)) continue;
      add(this.markdownFile(spaceKey, page));
      const attachments = this.attachmentsDir(spaceKey, page);
      if (fs.existsSync(attachments)) for (const name of fs.readdirSync(attachments)) add(path.join(attachments, name));
    }
    for (const name of ['TOC.md', 'toc.json', 'manifest.json']) add(path.join(dir, name));
    return entries;
  }

  /** Every synced page in the space that is not excluded, read in chunks so the server keeps answering. */
  /** Every page in the catalog that the exclusion rules allow: titles, places and tags, without text. */
  public async visibleEntries(spaceKey: string): Promise<CatalogEntry[]> {
    const key = spaceKey.toUpperCase();
    const entries = await this.catalog.ready(key);
    const excluded = this.exclusions.checker(key);
    return [...entries.values()].filter((p) => !excluded(p));
  }

  public async visiblePages(spaceKey: string): Promise<PageDetail[]> {
    const pages = await mapChunked(this.cachedIds(spaceKey), (id) => this.readPage(spaceKey, id));
    const excluded = this.exclusions.checker(spaceKey);
    return pages.filter((page): page is PageDetail => !!page && !excluded(page));
  }

  public writeMetadata(spaceKey: string, metadata: PageMetadata): void {
    const file = this.metadataFile(spaceKey, metadata.pageId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(metadata, null, 2), 'utf8');
    this.metadataRead.set(file, { mtimeMs: fs.statSync(file).mtimeMs, metadata });
    this.catalog.setMetadata(spaceKey.toUpperCase(), metadata);
    // A summary changes what the search finds but not the page tree, which an index run would
    // otherwise rebuild after every page.
    this.bump(spaceKey);
  }

  /** Saves a page's section embeddings, encoded by `src/spaces/vectors.ts`. */
  public writeVectors(spaceKey: string, pageId: string, vectors: PageVectors): void {
    const file = this.vectorsFile(spaceKey, pageId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(vectors), 'utf8');
  }

  public readVectors(spaceKey: string, pageId: string): PageVectors | undefined {
    const file = this.vectorsFile(spaceKey, pageId);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as PageVectors) : undefined;
  }

  /** Marks a space as changed, as after a write or a change to its exclusion rules. */
  public invalidate(spaceKey: string): void {
    this.trees.delete(spaceKey.toUpperCase());
    this.bump(spaceKey);
  }

  /** How many changes this store has made to a space; it grows with every write. */
  public revision(spaceKey: string): number {
    return this.revisions.get(spaceKey.toUpperCase()) ?? 0;
  }

  /**
   * A page's AI metadata. Whole-space views read every page's, so each is kept once read and read
   * again only when its file changes, which a cheap check of the file's time tells.
   */
  public readMetadata(spaceKey: string, pageId: string): PageMetadata | undefined {
    const file = this.metadataFile(spaceKey, pageId);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      this.metadataRead.delete(file);
      return undefined;
    }
    const kept = this.metadataRead.get(file);
    if (kept?.mtimeMs === stat.mtimeMs) return kept.metadata;
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8')) as PageMetadata;
    this.metadataRead.set(file, { mtimeMs: stat.mtimeMs, metadata });
    return metadata;
  }

  /**
   * Builds a space's page tree in chunks, letting other requests run between them, unless it is
   * already built. Whole-space work awaits this first, so the tree is never built in one go on a
   * request's path.
   */
  public async treeReady(spaceKey: string): Promise<void> {
    const key = spaceKey.toUpperCase();
    if (this.trees.has(key)) return;
    const pages = await this.catalog.ready(key);
    this.trees.set(key, this.treeOf(key, [...pages.values()]));
  }

  private bump(spaceKey: string): void {
    const key = spaceKey.toUpperCase();
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
  }

  private loadTree(spaceKey: string): { roots: PageTreeNode[]; byId: Map<string, PageTreeNode> } {
    const key = spaceKey.toUpperCase();
    const cached = this.trees.get(key);
    if (cached) return cached;
    const tree = this.treeOf(key, [...this.catalog.now(key).values()]);
    this.trees.set(key, tree);
    return tree;
  }

  private treeOf(key: string, pages: CatalogEntry[]): { roots: PageTreeNode[]; byId: Map<string, PageTreeNode> } {
    const onDisk = new Set(pages.map((p) => p.id));
    const byId = new Map<string, PageTreeNode>();
    const excluded = this.exclusions.checker(key);
    for (const page of pages) {
      if (excluded(page)) continue;
      const { id, title, spaceKey: space, parentId, version, author, lastModified, webUrl } = page;
      byId.set(id, {
        id,
        title,
        spaceKey: space || key,
        parentId,
        version,
        author,
        lastModified,
        webUrl,
        children: [],
      });
    }
    const roots: PageTreeNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) parent.children.push(node);
      // A page whose parent was excluded stays hidden with it, rather than appearing as a root.
      else if (!node.parentId || !onDisk.has(node.parentId)) roots.push(node);
    }
    const sort = (nodes: PageTreeNode[]): void => {
      nodes.sort((a, b) => a.title.localeCompare(b.title));
      nodes.forEach((n) => sort(n.children));
    };
    sort(roots);
    return { roots, byId };
  }

  private removePage(spaceKey: string, pageId: string, withFolder: boolean): void {
    const page = this.readPage(spaceKey, pageId);
    if (page) {
      fs.rmSync(this.markdownFile(spaceKey, page), { force: true });
      fs.rmSync(this.attachmentsDir(spaceKey, page), { recursive: true, force: true });
      if (withFolder)
        fs.rmSync(this.markdownFile(spaceKey, page).replace(/\.md$/, ''), { recursive: true, force: true });
    }
    fs.rmSync(this.cacheFile(spaceKey, pageId), { force: true });
    fs.rmSync(this.metadataFile(spaceKey, pageId), { force: true });
    fs.rmSync(this.vectorsFile(spaceKey, pageId), { force: true });
    this.catalog.remove(spaceKey.toUpperCase(), pageId);
    this.invalidate(spaceKey);
  }

  private async afterRemoval(spaceKey: string): Promise<void> {
    this.invalidate(spaceKey);
    if (fs.existsSync(path.join(this.spaceDir(spaceKey), 'toc.json'))) await this.writeToc(spaceKey);
  }

  private spaceKeys(): string[] {
    if (!fs.existsSync(this.spacesDir)) return [];
    return fs
      .readdirSync(this.spacesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }

  private cachedIds(spaceKey: string): string[] {
    const dir = path.join(this.spaceDir(spaceKey), 'pages_cache');
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      // No folder yet: the space has no synced pages.
      return [];
    }
    const key = spaceKey.toUpperCase();
    const revision = this.revision(key);
    const listed = this.idsListed.get(key);
    if (listed?.mtimeMs === mtimeMs && listed.revision === revision) return listed.ids;
    const ids = fs
      .readdirSync(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => f.slice(0, -5));
    this.idsListed.set(key, { mtimeMs, revision, ids });
    return ids;
  }

  private pagesDir(spaceKey: string): string {
    return path.join(this.spaceDir(spaceKey), 'pages');
  }

  private cacheFile(spaceKey: string, pageId: string): string {
    return within(this.spaceDir(spaceKey), 'pages_cache', `${sanitizeFilename(pageId)}.json`);
  }

  private metadataFile(spaceKey: string, pageId: string): string {
    return within(this.spaceDir(spaceKey), 'metadata', `${sanitizeFilename(pageId)}.json`);
  }

  private vectorsFile(spaceKey: string, pageId: string): string {
    return within(this.spaceDir(spaceKey), 'vectors', `${sanitizeFilename(pageId)}.json`);
  }

  private attachmentsDir(spaceKey: string, page: Pick<PageDetail, 'title' | 'ancestors'>): string {
    return this.markdownFile(spaceKey, page).replace(/\.md$/, '_attachments');
  }
}

/**
 * The file name each attachment is kept under: its title made safe for the disk, with a number added
 * when two titles become the same name, so neither file overwrites the other.
 */
/** A page's attachments as its folder holds them, each with its size, or marked missing. */
function listAttachments(dir: string, page: PageDetail): AttachmentFile[] {
  const names = attachmentFileNames(page.attachments.map((a) => a.title));
  return page.attachments.map((a, i) => {
    const file = within(dir, names[i]);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return {
      title: a.title,
      mediaType: a.mediaType,
      file,
      bytes: stat?.size ?? 0,
      ...(stat ? {} : { missing: true }),
    };
  });
}

export function attachmentFileNames(titles: string[]): string[] {
  const used = new Set<string>();
  return titles.map((title) => {
    const safe = sanitizeFilename(title);
    const dot = safe.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ''];
    let name = safe;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}
