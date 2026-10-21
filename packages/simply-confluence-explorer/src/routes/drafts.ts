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

import {
  checkDraft,
  checkRedundancy,
  coWrite,
  createFromDraft,
  addRepository,
  decide,
  draftOf,
  saveDraft,
  startDraft,
  type DraftDeps,
} from '../drafts/drafts.js';
import { isValidPageId, isValidSpaceKey } from '../http/guards.js';
import { HttpError, type Router } from '../http/router.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

/** A series' child pages from a request: each a title and its Markdown. */
function childrenOf(value: unknown): Array<{ title: string; markdown: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, 'children must be a list of pages');
  return value.map((v: unknown) => {
    const page = fieldsOf(v);
    if (typeof page.title !== 'string' || typeof page.markdown !== 'string')
      throw new HttpError(400, 'each page of a series has a title and its Markdown');
    return { title: page.title, markdown: page.markdown.slice(0, 200_000) };
  });
}

/**
 * Adds the routes for writing a new page with a co-writer, after a check for pages that already say
 * it (ADR-025).
 *
 * @param router The router to add to.
 * @param services What the routes share.
 */
export function addDraftRoutes(router: Router, services: Services): Router {
  const deps: DraftDeps = {
    ai: services.ai,
    index: services.index,
    sessions: services.sessions,
    store: services.store,
    exclusions: services.exclusions,
    client: services.client,
    dataDir: services.dataDir,
    log: services.log,
    gitlab: services.gitlab,
  };
  return (
    router
      .add('POST', '/api/drafts', ({ body }) => {
        const spaceKey = optionalString(body, 'spaceKey');
        const raw = fieldsOf(body).parentId;
        const parentId = typeof raw === 'number' ? String(raw) : optionalString(body, 'parentId');
        if (!isValidSpaceKey(spaceKey) || !isValidPageId(parentId))
          throw new HttpError(400, 'spaceKey and parentId are required');
        const title = optionalString(body, 'title');
        if (!title?.trim()) throw new HttpError(400, 'a title is required');
        return startDraft(
          {
            spaceKey: spaceKey.toUpperCase(),
            parentId,
            title: title.slice(0, 255),
            notes: (optionalString(body, 'notes') ?? '').slice(0, 20_000),
          },
          deps,
        );
      })
      // A new check replaces the old answer, so the author answers what they now see.
      .add('POST', '/api/drafts/:sessionId/recheck', async ({ params }) => {
        const { draft, scope, id } = draftOf(params.sessionId, deps);
        return services.sessions.updateDraft(id, {
          redundancy: await checkRedundancy(scope.spaceKey, draft.title, draft.notes, deps),
        });
      })
      .add('POST', '/api/drafts/:sessionId/decision', ({ params, body }) => {
        const linked = fieldsOf(body).linkedPageIds;
        const ids = Array.isArray(linked)
          ? linked.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number').map(String)
          : [];
        return decide(params.sessionId, optionalString(body, 'decision') ?? '', ids, deps);
      })
      .add('PUT', '/api/drafts/:sessionId', ({ params, body }) => {
        const example = fieldsOf(body).examplePageId;
        const examplePageId = typeof example === 'number' ? String(example) : example;
        if (examplePageId !== undefined && examplePageId !== '' && !isValidPageId(examplePageId))
          throw new HttpError(400, 'invalid examplePageId');
        return saveDraft(
          params.sessionId,
          {
            title: optionalString(body, 'title'),
            markdown: optionalString(body, 'markdown'),
            notes: optionalString(body, 'notes'),
            examplePageId,
            template: optionalString(body, 'template'),
            children: childrenOf(fieldsOf(body).children),
          },
          deps,
        );
      })
      .add('POST', '/api/drafts/:sessionId/repositories', ({ params, body }) => {
        const link = optionalString(body, 'link')?.trim();
        if (!link) throw new HttpError(400, 'a link to a GitLab repository is required');
        return addRepository(params.sessionId, link, deps);
      })
      .add('POST', '/api/drafts/:sessionId/messages', ({ params, body, signal }) => {
        const prompt = optionalString(body, 'prompt')?.trim();
        if (!prompt) throw new HttpError(400, 'prompt is required');
        return coWrite(params.sessionId, prompt, deps, signal);
      })
      .add('POST', '/api/drafts/:sessionId/turns/:turn/close-proposal', ({ params }) => {
        const { id, turns } = draftOf(params.sessionId, deps);
        const turn = Number(params.turn);
        if (turns[turn]?.proposedDraft === undefined && turns[turn]?.proposedSeries === undefined)
          throw new HttpError(404, 'that answer proposed nothing');
        return services.sessions.closeProposal(id, turn);
      })
      .add('POST', '/api/drafts/:sessionId/check', ({ params }) => checkDraft(params.sessionId, deps))
      .add('POST', '/api/drafts/:sessionId/create', ({ params }) => createFromDraft(params.sessionId, deps))
  );
}
