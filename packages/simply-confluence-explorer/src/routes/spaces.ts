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

import archiver from 'archiver';
import type { PurgeResult, SectionPage, SpaceTocNode, SyncProgress } from '../api/types.js';
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
      .add('GET', '/api/space-cache/cached', () => ({ spaces: store.listSynced() }))
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
      .add('GET', '/api/space-cache/:spaceKey/toc', ({ params }): { toc: SpaceTocNode[] } => {
        if (!store.isSynced(params.spaceKey))
          throw new HttpError(404, `${params.spaceKey} has not been synced, so it has no table of contents`);
        return { toc: store.writeToc(params.spaceKey) };
      })
      // The pages a section review can offer, each with its depth under the section's page. A page the
      // exclusion rules cover is left out, so the browser is never offered what it may not send.
      .add('GET', '/api/space-cache/:spaceKey/pages/:pageId/section', ({ params }): { pages: SectionPage[] } => {
        const key = params.spaceKey.toUpperCase();
        const depth = new Map([[params.pageId, 0]]);
        const nodes = [store.readPage(key, params.pageId), ...store.descendants(key, params.pageId)];
        const pages: SectionPage[] = [];
        for (const node of nodes) {
          if (!node) continue;
          const d = node.id === params.pageId ? 0 : (depth.get(node.parentId ?? '') ?? 0) + 1;
          depth.set(node.id, d);
          const page = store.readPage(key, node.id);
          if (page && !exclusions.isPageExcluded(page, key)) pages.push({ id: page.id, title: page.title, depth: d });
        }
        return { pages };
      })
      .add('GET', '/api/space-cache/:spaceKey/pages/:pageId/descendants', ({ params }) => {
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
      .add('POST', '/api/space-cache/:spaceKey/pages/:pageId/purge', ({ params, body }) =>
        store.purgePage(params.spaceKey, params.pageId, {
          includeSubPages: flag(body, 'includeSubPages'),
          addToIgnore: flag(body, 'addToIgnore'),
        }),
      )
      .add('POST', '/api/space-cache/:spaceKey/cache/purge', ({ params }): PurgeResult =>
        store.purgeStale(params.spaceKey),
      )
      .add('GET', '/api/space-cache/:spaceKey/ignore', ({ params }) => ({
        spaceKey: params.spaceKey.toUpperCase(),
        patterns: exclusions.patterns(params.spaceKey),
      }))
      .add('POST', '/api/space-cache/:spaceKey/ignore', ({ params, body }) => {
        const patterns = fieldsOf(body).patterns;
        if (!Array.isArray(patterns) || !patterns.every((p): p is string => typeof p === 'string')) {
          throw new HttpError(400, 'patterns must be a list of strings');
        }
        exclusions.savePatterns(params.spaceKey, patterns);
        store.invalidate(params.spaceKey);
        // With purge, the synced copies of newly excluded pages are deleted too, because a ZIP and a
        // person browsing the folder would otherwise still find them.
        const purged =
          flag(body, 'purge') && store.isSynced(params.spaceKey) ? store.purgeStale(params.spaceKey) : undefined;
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
