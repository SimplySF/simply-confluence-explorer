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
import { errorMessage } from '../util/errors.js';
import { sanitizeFilename, within } from '../util/paths.js';
import type { ExclusionManager } from './exclusionManager.js';

// A synced space lives in `<data dir>/spaces/<KEY>/`:
//
//   pages_cache/<id>.json   each page as read from Confluence, which the app reads back
//   pages/.../<Title>.md    the same pages as Markdown, in folders that follow the page tree
//   pages/.../<Title>_attachments/   each page's attachments
//   metadata/<id>.json      AI summaries and tags, written by the metadata run
//   manifest.json           when the space was synced and from which page
//   toc.json, TOC.md        the table of contents
//
// pages/ is for people: they may read it, zip it, or delete a folder from it. The app reads
// pages_cache/, and purging reconciles the two.

type Manifest = Omit<SyncedSpace, 'metadataCount' | 'hasTOC'>;

export class SpaceStore {
  private readonly spacesDir: string;
  // Built from pages_cache once per change, because a large space has thousands of files.
  private readonly trees = new Map<string, { roots: PageTreeNode[]; byId: Map<string, PageTreeNode> }>();

  public constructor(
    dataDir: string,
    private readonly exclusions: ExclusionManager,
    private readonly log: (message: string) => void,
  ) {
    this.spacesDir = path.join(dataDir, 'spaces');
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

  /** The synced space a page belongs to, when the caller does not know it. */
  public findSpaceKey(pageId: string): string | undefined {
    return this.spaceKeys().find((key) => fs.existsSync(this.cacheFile(key, pageId)));
  }

  /** Writes a page's cached copy, its Markdown and its attachments. */
  public writePage(
    spaceKey: string,
    page: PageDetail,
    markdown: string,
    attachments: Array<{ name: string; data: Buffer }>,
  ): void {
    const cacheFile = this.cacheFile(spaceKey, page.id);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const mdFile = this.markdownFile(spaceKey, page);
    fs.mkdirSync(path.dirname(mdFile), { recursive: true });
    fs.writeFileSync(mdFile, markdown, 'utf8');
    if (attachments.length > 0) {
      const dir = this.attachmentsDir(spaceKey, page);
      fs.mkdirSync(dir, { recursive: true });
      for (const a of attachments) fs.writeFileSync(within(dir, sanitizeFilename(a.name)), a.data);
    }
    fs.writeFileSync(cacheFile, JSON.stringify(page, null, 2), 'utf8');
    // A newer version makes the old summary and tags stale.
    fs.rmSync(this.metadataFile(spaceKey, page.id), { force: true });
    this.trees.delete(spaceKey.toUpperCase());
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

  public listSynced(): SyncedSpace[] {
    return this.spaceKeys().flatMap((key) => {
      const dir = this.spaceDir(key);
      const file = path.join(dir, 'manifest.json');
      if (!fs.existsSync(file)) return [];
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
      const metadataDir = path.join(dir, 'metadata');
      return [
        {
          ...manifest,
          pageCount: this.cachedIds(key).length,
          metadataCount: fs.existsSync(metadataDir)
            ? fs.readdirSync(metadataDir).filter((f) => f.endsWith('.json')).length
            : 0,
          hasTOC: fs.existsSync(path.join(dir, 'toc.json')),
        },
      ];
    });
  }

  /**
   * Deletes the synced copies of pages that are now excluded, or whose Markdown file a person
   * deleted from pages/, and rebuilds the table of contents.
   */
  public purgeStale(spaceKey: string): { purgedCount: number; remainingPages: number } {
    const stale = this.cachedIds(spaceKey).filter((id) => {
      const page = this.readPage(spaceKey, id);
      return (
        !page || this.exclusions.isPageExcluded(page, spaceKey) || !fs.existsSync(this.markdownFile(spaceKey, page))
      );
    });
    for (const id of stale) this.removePage(spaceKey, id, false);
    this.afterRemoval(spaceKey);
    return { purgedCount: stale.length, remainingPages: this.cachedIds(spaceKey).length };
  }

  /**
   * Deletes one synced page, and optionally everything below it, from this machine. With
   * `addToIgnore`, rules are added so the next sync does not bring it back.
   */
  public purgePage(
    spaceKey: string,
    pageId: string,
    options: { includeSubPages: boolean; addToIgnore: boolean },
  ): { purgedCount: number } {
    const page = this.readPage(spaceKey, pageId);
    if (!page) return { purgedCount: 0 };
    const ids = [pageId, ...(options.includeSubPages ? this.descendants(spaceKey, pageId).map((d) => d.id) : [])];
    if (options.addToIgnore) {
      const rules = options.includeSubPages ? [`${page.title}/`, `*${page.title}*`] : [page.title, `id:${page.id}`];
      this.exclusions.savePatterns(spaceKey, [...new Set([...this.exclusions.patterns(spaceKey), ...rules])]);
    }
    for (const id of ids) this.removePage(spaceKey, id, options.includeSubPages);
    this.afterRemoval(spaceKey);
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

  /** The table of contents, built from the visible synced pages and any AI summaries. */
  public buildToc(spaceKey: string): SpaceTocNode[] {
    const toNode = (node: PageTreeNode): SpaceTocNode => {
      const page = this.readPage(spaceKey, node.id);
      const meta = this.readMetadata(spaceKey, node.id);
      return {
        id: node.id,
        title: node.title,
        path: page
          ? path.relative(this.pagesDir(spaceKey), this.markdownFile(spaceKey, page)).split(path.sep).join('/')
          : '',
        summary: meta?.summary,
        tags: meta?.tags ?? page?.labels ?? [],
        documentType: meta?.documentType,
        children: node.children.map(toNode),
      };
    };
    return this.tree(spaceKey).map(toNode);
  }

  /** Writes toc.json, and TOC.md for people browsing the folder, for a synced space. */
  public writeToc(spaceKey: string): SpaceTocNode[] {
    const toc = this.buildToc(spaceKey);
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
    for (const id of this.cachedIds(spaceKey)) {
      const page = this.readPage(spaceKey, id);
      if (!page || this.exclusions.isPageExcluded(page, spaceKey)) continue;
      add(this.markdownFile(spaceKey, page));
      const attachments = this.attachmentsDir(spaceKey, page);
      if (fs.existsSync(attachments)) for (const name of fs.readdirSync(attachments)) add(path.join(attachments, name));
    }
    for (const name of ['TOC.md', 'toc.json', 'manifest.json']) add(path.join(dir, name));
    return entries;
  }

  /** Every synced page in the space that is not excluded. */
  public visiblePages(spaceKey: string): PageDetail[] {
    return this.cachedIds(spaceKey).flatMap((id) => {
      const page = this.readPage(spaceKey, id);
      return page && !this.exclusions.isPageExcluded(page, spaceKey) ? [page] : [];
    });
  }

  public writeMetadata(spaceKey: string, metadata: PageMetadata): void {
    const file = this.metadataFile(spaceKey, metadata.pageId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(metadata, null, 2), 'utf8');
  }

  public invalidate(spaceKey: string): void {
    this.trees.delete(spaceKey.toUpperCase());
  }

  public readMetadata(spaceKey: string, pageId: string): PageMetadata | undefined {
    const file = this.metadataFile(spaceKey, pageId);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as PageMetadata) : undefined;
  }

  private loadTree(spaceKey: string): { roots: PageTreeNode[]; byId: Map<string, PageTreeNode> } {
    const key = spaceKey.toUpperCase();
    const cached = this.trees.get(key);
    if (cached) return cached;
    const pages = this.cachedIds(key).flatMap((id) => {
      try {
        const page = this.readPage(key, id);
        return page ? [page] : [];
      } catch (error) {
        // One damaged file must not hide the rest of the space; it is reported and left out.
        this.log(`cannot read the synced copy of page ${id} in ${key}: ${errorMessage(error)}`);
        return [];
      }
    });
    const byId = new Map<string, PageTreeNode>();
    for (const page of pages) {
      if (this.exclusions.isPageExcluded(page, key)) continue;
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
      else if (!node.parentId || !pages.some((p) => p.id === node.parentId)) roots.push(node);
    }
    const sort = (nodes: PageTreeNode[]): void => {
      nodes.sort((a, b) => a.title.localeCompare(b.title));
      nodes.forEach((n) => sort(n.children));
    };
    sort(roots);
    const tree = { roots, byId };
    this.trees.set(key, tree);
    return tree;
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
  }

  private afterRemoval(spaceKey: string): void {
    this.invalidate(spaceKey);
    if (fs.existsSync(path.join(this.spaceDir(spaceKey), 'toc.json'))) this.writeToc(spaceKey);
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
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => f.slice(0, -5));
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

  private attachmentsDir(spaceKey: string, page: Pick<PageDetail, 'title' | 'ancestors'>): string {
    return this.markdownFile(spaceKey, page).replace(/\.md$/, '_attachments');
  }
}
