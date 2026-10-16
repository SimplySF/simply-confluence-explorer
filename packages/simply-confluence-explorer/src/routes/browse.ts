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

import type { PageResponse, PageTreeNode, ResolveResponse } from '../api/types.js';
import { ConfluenceClient } from '../confluence/client.js';
import { HttpError, type Router } from '../http/router.js';
import { parsePage, storageToBody } from '../parser/convert.js';
import type { ExclusionManager } from '../spaces/exclusionManager.js';
import type { Services } from './api.js';

const fieldsOf = (body: unknown): Record<string, unknown> =>
  body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};

const optionalString = (body: unknown, key: string): string | undefined => {
  const value = fieldsOf(body)[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${key} must be a string`);
  return value;
};

/**
 * Pulls a page id and a space key out of whatever a person pasted: a bare page id, or a Confluence
 * address in any of the forms Server and Data Center use (`?pageId=`, `/pages/<id>`,
 * `/spaces/<KEY>`, `/display/<KEY>`).
 *
 * @param input The pasted text.
 */
export function parseConfluenceInput(input: string): ResolveResponse {
  const text = input.trim();
  if (/^\d+$/.test(text)) return { pageId: text };
  const pageId = /\/pages\/(\d+)(?:\/|$|\?)/i.exec(text)?.[1] ?? /[?&]pageId=(\d+)/i.exec(text)?.[1];
  const spaceKey = /\/(?:spaces|display)\/([A-Za-z0-9_-]+)(?:\/|$|\?)/i.exec(text)?.[1]?.toUpperCase();
  return { pageId, spaceKey };
}

/** Removes every excluded page, and everything below it, from a tree before it reaches the browser. */
function visibleTree(
  nodes: PageTreeNode[],
  spaceKey: string,
  exclusions: ExclusionManager,
  ancestors: Array<{ title: string }> = [],
): PageTreeNode[] {
  return nodes
    .filter((n) => !exclusions.isPageExcluded({ id: n.id, title: n.title, ancestors }, spaceKey))
    .map((n) => ({
      ...n,
      children: visibleTree(n.children, spaceKey, exclusions, [...ancestors, { title: n.title }]),
    }));
}

/**
 * Adds the routes that read Confluence live: testing a connection, listing spaces, reading a
 * space's page tree and reading one page. Excluded pages are left out of trees and answered with a
 * 404, so they never appear in the browser either.
 *
 * @param router The router to add to.
 * @param services What the routes share.
 */
export function addBrowseRoutes(router: Router, services: Services): Router {
  const { connection, exclusions } = services;
  const client = (): ConfluenceClient => new ConfluenceClient(connection.resolve());

  return (
    router
      .add('POST', '/api/auth/verify', async ({ body }) => {
        // Tests the connection typed into Settings, or the saved one, without saving anything.
        const candidate = connection.candidate({
          baseUrl: optionalString(body, 'baseUrl'),
          token: optionalString(body, 'token'),
        });
        const started = Date.now();
        const result = await new ConfluenceClient(candidate).verify();
        return { ...result, latencyMs: Date.now() - started };
      })
      .add('GET', '/api/spaces', async ({ query }) => ({
        spaces: await client().getSpaces(query.get('query') ?? undefined),
      }))
      .add('GET', '/api/spaces/detail/:spaceKey', ({ params }) => client().getSpace(params.spaceKey))
      .add('POST', '/api/spaces/resolve-url', async ({ body }): Promise<ResolveResponse> => {
        const input = optionalString(body, 'input');
        if (!input?.trim()) throw new HttpError(400, 'a Confluence URL or page id is required');
        const found = parseConfluenceInput(input);
        const confluence = client();
        if (found.pageId)
          return {
            pageId: found.pageId,
            spaceKey: (await confluence.getPageDetail(found.pageId)).spaceKey || found.spaceKey,
          };
        if (found.spaceKey)
          return { spaceKey: found.spaceKey, pageId: (await confluence.getSpace(found.spaceKey)).homepageId };
        throw new HttpError(404, 'no page id or space key could be found in that input');
      })
      .add('GET', '/api/spaces/:spaceKey/pages', async ({ params, query }) => {
        const spaceKey = params.spaceKey.toUpperCase();
        const tree = await client().getPageTree(spaceKey, query.get('rootPageId') ?? undefined);
        return { tree: visibleTree(tree, spaceKey, exclusions) };
      })
      .add('GET', '/api/pages/:pageId', async ({ params, query }): Promise<PageResponse> => {
        const detail = await client().getPageDetail(params.pageId);
        const spaceKey = query.get('spaceKey')?.toUpperCase() ?? detail.spaceKey;
        if (exclusions.isPageExcluded(detail, spaceKey) || exclusions.isPageExcluded(detail, detail.spaceKey)) {
          throw new HttpError(404, 'Page not found, or excluded by .confluenceignore');
        }
        return { detail, parsed: parsePage(detail) };
      })
      // Converts a pasted storage-format snippet, for the snippet parser. Nothing is read or stored.
      .add('POST', '/api/parse', ({ body }) => ({ markdown: storageToBody(optionalString(body, 'storageXml') ?? '') }))
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
        return { spaceKey: params.spaceKey.toUpperCase(), patterns: exclusions.patterns(params.spaceKey) };
      })
  );
}
