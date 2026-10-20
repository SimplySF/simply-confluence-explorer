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

import type { WriteResult } from '../api/types.js';
import { HttpError } from '../http/router.js';
import { stripFrontmatter } from '../parser/convert.js';
import { buildStorage, toEditForm } from '../parser/editForm.js';
import type { SpaceStore } from '../spaces/spaceStore.js';
import { errorMessage } from '../util/errors.js';
import type { ConfluenceClient } from './client.js';

// This is the one path that changes an existing page in Confluence (ADR-024). Branch runs push
// through it too, so the checks below hold for every write.

export type PageWrite = {
  pageId: string;
  markdown: string;
  title?: string;
  append?: boolean;
  /** The page version the change was made from. Required to write; optional for a dry run. */
  baseVersion?: number;
  dryRun: boolean;
  spaceKey?: string;
  /** The parts of the page, by marker number, that a person accepted removing (ADR-058). */
  removes?: number[];
};

/**
 * Writes a change to a page, or checks it without writing. The change must name the version it was
 * made from, and the write is refused if the page has moved on since, because writing anyway would
 * replace a colleague's edit nobody has seen. The frontmatter block the app adds to a page's
 * Markdown is removed first, so it never lands in Confluence.
 *
 * The change is the page's edit form (ADR-058): text with a marker for each part Markdown has no
 * form for. The storage is built from it against the page as Confluence holds it, so a block the
 * change leaves alone is written exactly as it was and each marked part is put back where its
 * marker stands. A part missing from the result refuses the write unless `removes` names it. A dry
 * run builds and checks the storage exactly as a write would and stops there. After a write, the
 * synced copy is replaced with what Confluence now holds, so the next read and the next proposal
 * start from the page as it is.
 *
 * @param client The Confluence client.
 * @param store The synced copies.
 * @param log Where a failed refresh of the synced copy is reported.
 * @param w The change.
 */
export async function writePage(
  client: ConfluenceClient,
  store: SpaceStore,
  log: (message: string) => void,
  w: PageWrite,
): Promise<WriteResult> {
  if (!w.dryRun && typeof w.baseVersion !== 'number') {
    throw new HttpError(400, 'baseVersion, the page version the proposal was made from, is required to write');
  }
  const stale = (now: number, base: number): HttpError =>
    new HttpError(
      409,
      `This page changed in Confluence after the proposal was made (it is now version ${now}; ` +
        `the proposal was based on version ${base}). Reload the page and make the proposal again.`,
    );
  const markdown = stripFrontmatter(w.markdown);
  let plan;
  try {
    let body: string | undefined;
    if (!w.append) {
      const current = await client.getPageDetail(w.pageId);
      if (typeof w.baseVersion === 'number' && current.version !== w.baseVersion)
        throw stale(current.version, w.baseVersion);
      body = buildStorage(toEditForm(current.storageXml), markdown, w.removes);
    }
    plan = await client.prepareUpdate(w.pageId, {
      ...(body === undefined ? { markdown } : { body }),
      title: w.title,
      append: w.append,
    });
  } catch (error) {
    if (w.dryRun && error instanceof HttpError && error.status === 400) {
      throw new HttpError(400, `The dry run found a problem: ${error.message}`);
    }
    throw error;
  }
  if (typeof w.baseVersion === 'number' && plan.version !== w.baseVersion) throw stale(plan.version, w.baseVersion);
  if (w.dryRun) return { pageId: w.pageId, version: plan.version, dryRun: true };

  await client.applyUpdate(plan);
  const space = w.spaceKey ?? store.findSpaceKey(w.pageId);
  let version = plan.version + 1;
  if (space && store.readPage(space, w.pageId)) {
    try {
      const page = await client.getPageDetail(w.pageId);
      store.refreshPage(space, page);
      version = page.version;
    } catch (error) {
      // The write succeeded; only the synced copy is stale, and the next sync refreshes it.
      log(`wrote page ${w.pageId} but could not refresh its synced copy: ${errorMessage(error)}`);
    }
  }
  return { pageId: w.pageId, version, dryRun: false };
}

export type PageCreate = {
  spaceKey: string;
  title: string;
  parentId: string;
  markdown: string;
  dryRun: boolean;
};

/**
 * Creates a page, or with a dry run checks that Confluence would accept it, without creating
 * anything. This is the one way a page is created (ADR-025), and its caller has already had the
 * author answer the check for pages that may already say the same thing. A new page is synced at
 * once when its space is synced, so it appears in the tree and in searches.
 *
 * @param client The Confluence client.
 * @param store The synced copies.
 * @param log Where a failed sync of the new page is reported.
 * @param c The page to create.
 */
export async function createPage(
  client: ConfluenceClient,
  store: SpaceStore,
  log: (message: string) => void,
  c: PageCreate,
): Promise<{ pageId?: string; webUrl?: string }> {
  let created;
  try {
    created = await client.createPage({ ...c, markdown: stripFrontmatter(c.markdown) });
  } catch (error) {
    if (c.dryRun && error instanceof HttpError && error.status === 400)
      throw new HttpError(400, `The dry run found a problem: ${error.message}`);
    throw error;
  }
  if (!c.dryRun && created.pageId && store.isSynced(c.spaceKey)) {
    try {
      store.refreshPage(c.spaceKey, await client.getPageDetail(created.pageId));
    } catch (error) {
      // The page exists; only the synced copy lacks it, and the next sync adds it.
      log(`created page ${created.pageId} but could not sync it: ${errorMessage(error)}`);
    }
  }
  return created;
}
