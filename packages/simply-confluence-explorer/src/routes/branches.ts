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

const DECISIONS = new Set(['accept', 'reject', 'reset']);

/**
 * Adds the routes for a queue of staged edits: read it, stop it, decide on each page, and check or
 * push the accepted ones (ADR-024). A queue is filled from a chat's suggestions (ADR-049); only the
 * pages a person accepts are checked and pushed, one at a time, each against the version its edit was
 * made from.
 *
 * @param router The router to add to.
 * @param services What the routes share.
 */
export function addBranchRoutes(router: Router, services: Services): Router {
  const { branches } = services;
  return (
    router
      .add('GET', '/api/branches/runs/:runId', ({ params }) => branches.get(params.runId))
      .add('POST', '/api/branches/runs/:runId/cancel', ({ params }) => branches.cancel(params.runId))
      .add('PATCH', '/api/branches/runs/:runId/items/:pageId', ({ params, body }) => {
        const decision = optionalString(body, 'decision');
        if (!decision || !DECISIONS.has(decision)) throw new HttpError(400, 'decision must be accept, reject or reset');
        return branches.decide(
          params.runId,
          params.pageId,
          decision as 'accept' | 'reject' | 'reset',
          optionalString(body, 'proposed'),
        );
      })
      // Dry-runs every accepted page; nothing is written.
      .add('POST', '/api/branches/runs/:runId/check', ({ params }) => branches.check(params.runId))
      // Writes every accepted page, one at a time, each against its own base version.
      .add('POST', '/api/branches/runs/:runId/push', ({ params }) => branches.push(params.runId))
  );
}
