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

import { HttpError, type Router } from '../http/router.js';
import type { Services } from './api.js';
import { optionalString } from './browse.js';

const oneOf = <T extends string>(body: unknown, key: string, allowed: readonly T[]): T => {
  const value = optionalString(body, key);
  if (!value || !(allowed as readonly string[]).includes(value))
    throw new HttpError(400, `${key} must be ${allowed.join(', ').replace(/, ([^,]*)$/, ' or $1')}`);
  return value as T;
};

/**
 * Adds the routes for a queue of staged edits: read it, stop it, decide on each change of each
 * page, edit or reset a page's text, and check or push the accepted changes (ADR-024, ADR-059). A
 * queue is filled from a chat's suggestions (ADR-049); only the changes a person accepts are checked
 * and pushed, a page at a time, each against the version its edit was made from.
 *
 * @param router The router to add to.
 * @param services What the routes share.
 */
export function addBranchRoutes(router: Router, services: Services): Router {
  const { branches } = services;
  const item = '/api/branches/runs/:runId/items/:pageId';
  return (
    router
      .add('GET', '/api/branches/runs/:runId', ({ params }) => branches.get(params.runId))
      .add('POST', '/api/branches/runs/:runId/cancel', ({ params }) => branches.cancel(params.runId))
      .add('PATCH', `${item}/changes/:changeId`, ({ params, body }) =>
        branches.decideChange(
          params.runId,
          params.pageId,
          params.changeId,
          oneOf(body, 'decision', ['accept', 'reject', 'undo'] as const),
        ),
      )
      .add('POST', `${item}/decide-all`, ({ params, body }) =>
        branches.decideAll(params.runId, params.pageId, oneOf(body, 'decision', ['accept', 'reject'] as const)),
      )
      .add('PUT', `${item}/text`, ({ params, body }) => {
        const text = optionalString(body, 'text');
        if (text === undefined) throw new HttpError(400, 'text is required');
        return branches.setText(params.runId, params.pageId, text);
      })
      .add('POST', `${item}/reset`, ({ params }) => branches.reset(params.runId, params.pageId))
      .add('POST', `${item}/redo`, ({ params }) => branches.redo(params.runId, params.pageId))
      // Dry-runs every page with accepted changes; nothing is written.
      .add('POST', '/api/branches/runs/:runId/check', ({ params }) => branches.check(params.runId))
      // Writes each page's accepted changes, one page at a time, each against its own base version.
      .add('POST', '/api/branches/runs/:runId/push', ({ params }) => branches.push(params.runId))
  );
}
