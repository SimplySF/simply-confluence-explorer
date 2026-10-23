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
import archiver from 'archiver';
import type { PurgeResult, SpaceTocNode, SyncProgress, TagsResponse } from '../api/types.js';
import { IMAGE_TYPES } from '../spaces/attachments.js';
import { tagIndex } from '../spaces/tags.js';
import { HttpError, type Router } from '../http/router.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

const flag = (body: unknown, key: string): boolean => fieldsOf(body)[key] === true;

/**
 * Adds the routes for the copy of a space kept on this machine: syncing it, its table of contents,
 * its ZIP, its exclusion rules, and removing pages from it.
 *
 * @param router The router to add to.
 * @param services What the routes share.
 */
export function addSpaceRoutes(router: Router, services: Services): Router {
  const { store, sync, exclusions } = services;
  const notFound = (jobId: string): never => {
    throw new HttpError(404, `no sync job ${jobId}`);
  };

  return (
    router
      .add('GET', '/api/space-cache/cached', async () => ({ spaces: await store.listSynced() }))
      .add('POST', '/api/space-cache/sync', ({ body }): SyncProgress => {
        const spaceKey = optionalString(body, 'spaceKey');
        if (!spaceKey) throw new HttpError(400, 'spaceKey is required');
        return sync.start(spaceKey, optionalString(body, 'rootPageId'));
      })
      .add(
        'GET',
        '/api/space-cache/sync/status/:jobId',
        ({ params }) => sync.get(params.jobId) ?? notFound(params.jobId),
      )
      .add('POST', '/api/space-cache/sync/cancel/:jobId', ({ params }) => ({ cancelled: sync.cancel(params.jobId) }))
      .add('GET', '/api/space-cache/:spaceKey/sync/active', ({ params }) => ({
        activeJob: sync.activeFor(params.spaceKey) ?? null,
      }))
      .add('GET', '/api/space-cache/:spaceKey/toc', async ({ params }): Promise<{ toc: SpaceTocNode[] }> => {
        if (!store.isSynced(params.spaceKey))
          throw new HttpError(404, `${params.spaceKey} has not been synced, so it has no table of contents`);
        return { toc: await store.writeToc(params.spaceKey) };
      })
      // Answers at once: while the space's catalog is first built, with how far it has got (ADR-064).
      .add('GET', '/api/space-cache/:spaceKey/tags', async ({ params }): Promise<TagsResponse> => {
        if (!store.isSynced(params.spaceKey))
          throw new HttpError(404, `${params.spaceKey} has not been synced, so its tags are not known`);
        const key = params.spaceKey.toUpperCase();
        const building = store.catalog.progress(key);
        return building ? { tags: [], building } : { tags: await tagIndex(store, key) };
      })
      .add('GET', '/api/space-cache/:spaceKey/pages/:pageId/descendants', async ({ params }) => {
        // The tree is built in chunks on a first request, rather than all at once while others wait.
        await store.treeReady(params.spaceKey);
        const descendants = store.descendants(params.spaceKey, params.pageId);
        return {
          pageId: params.pageId,
          count: descendants.length,
          descendantIds: descendants.map((d) => d.id),
          titles: descendants.map((d) => d.title),
        };
      })
      .add('GET', '/api/space-cache/:spaceKey/pages/:pageId/exclusion-status', ({ params }) => {
        const page = store.readPage(params.spaceKey, params.pageId);
        return { pageId: params.pageId, isExcluded: page ? exclusions.isPageExcluded(page, params.spaceKey) : false };
      })
      // One image attached to a synced page, by its place in the page's list, so the edit view can
      // show what a marker stands for (ADR-068). Only image types are served, and no path is read
      // from the request.
      .add('GET', '/api/space-cache/:spaceKey/pages/:pageId/attachments/:attachment', ({ params, res }) => {
        const page = store.readPage(params.spaceKey, params.pageId);
        if (!page || exclusions.isPageExcluded(page, params.spaceKey))
          throw new HttpError(404, 'that page is not synced on this machine');
        const title = page.attachments[Number(params.attachment)]?.title;
        const type = title ? IMAGE_TYPES[path.extname(title).toLowerCase()] : undefined;
        const found = type && store.attachmentFiles(params.spaceKey, page).find((f) => f.title === title);
        if (!found) throw new HttpError(404, 'that page has no such image on this machine');
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': found.bytes,
          'Cache-Control': 'private, no-cache',
        });
        res.end(fs.readFileSync(found.file));
        return undefined;
      })
      .add('POST', '/api/space-cache/:spaceKey/pages/:pageId/purge', ({ params, body }) =>
        store.purgePage(params.spaceKey, params.pageId, {
          includeSubPages: flag(body, 'includeSubPages'),
          addToIgnore: flag(body, 'addToIgnore'),
        }),
      )
      .add('POST', '/api/space-cache/:spaceKey/cache/purge', ({ params }): Promise<PurgeResult> =>
        store.purgeStale(params.spaceKey),
      )
      .add('GET', '/api/space-cache/:spaceKey/ignore', ({ params }) => ({
        spaceKey: params.spaceKey.toUpperCase(),
        patterns: exclusions.patterns(params.spaceKey),
      }))
      .add('POST', '/api/space-cache/:spaceKey/ignore', async ({ params, body }) => {
        const patterns = fieldsOf(body).patterns;
        if (!Array.isArray(patterns) || !patterns.every((p): p is string => typeof p === 'string')) {
          throw new HttpError(400, 'patterns must be a list of strings');
        }
        exclusions.savePatterns(params.spaceKey, patterns);
        store.invalidate(params.spaceKey);
        // With purge, the synced copies of newly excluded pages are deleted too, because a ZIP and a
        // person browsing the folder would otherwise still find them.
        const purged =
          flag(body, 'purge') && store.isSynced(params.spaceKey) ? await store.purgeStale(params.spaceKey) : undefined;
        return { spaceKey: params.spaceKey.toUpperCase(), patterns: exclusions.patterns(params.spaceKey), purged };
      })
      .add('GET', '/api/space-cache/:spaceKey/zip', async ({ params, res }) => {
        const key = params.spaceKey.toUpperCase();
        if (!store.isSynced(key))
          throw new HttpError(404, `${key} has not been synced, so there is nothing to download`);
        const entries = store.zipEntries(key);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${key}_space.zip"`,
        });
        const archive = archiver('zip', { zlib: { level: 9 } });
        const done = new Promise<void>((resolve, reject) => {
          archive.on('error', reject);
          res.on('close', resolve);
        });
        archive.pipe(res);
        for (const entry of entries) archive.file(entry.file, { name: `${key}/${entry.name}` });
        await archive.finalize();
        await done;
        return undefined;
      })
  );
}
