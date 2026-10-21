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

import { isValidPageId } from '../http/guards.js';
import { HttpError, type Router } from '../http/router.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

/** The staged pages a check or push is limited to, when the request names some. */
const pageIdsOf = (body: unknown): string[] | undefined => {
  const ids = fieldsOf(body).pageIds;
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every(isValidPageId))
    throw new HttpError(400, 'pageIds must be a list of page ids');
  return ids;
};

const oneOf = <T extends string>(body: unknown, key: string, allowed: readonly T[]): T => {
  const value = optionalString(body, key);
  if (!value || !(allowed as readonly string[]).includes(value))
    throw new HttpError(400, `${key} must be ${allowed.join(', ').replace(/, ([^,]*)$/, ' or $1')}`);
  return value as T;
};

/**
 * Adds the routes for a run of edits: read it, stop it, decide on each change of each page, edit or
 * reset a page's text, stage a page, and check or push the staged pages (ADR-024, ADR-059, ADR-060).
 * A run is made from a chat's suggestions; only the changes a person accepts, on the pages they
 * staged, are checked and pushed, a page at a time, each against the version its edit was made from.
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
      .add('POST', `${item}/stage`, ({ params, body }) => {
        const staged = fieldsOf(body).staged;
        if (typeof staged !== 'boolean') throw new HttpError(400, 'staged must be true or false');
        return branches.stage(params.runId, params.pageId, staged);
      })
      // Dry-runs the staged pages, or those of them named; nothing is written.
      .add('POST', '/api/branches/runs/:runId/check', ({ params, body }) =>
        branches.check(params.runId, pageIdsOf(body)),
      )
      // Writes each staged page's accepted changes, one page at a time, each against its own base version.
      .add('POST', '/api/branches/runs/:runId/push', ({ params, body }) => branches.push(params.runId, pageIdsOf(body)))
  );
}
