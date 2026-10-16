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

import type { BranchRun } from '../api/types.js';
import { isValidPageId, isValidSpaceKey } from '../http/guards.js';
import { HttpError, type Router } from '../http/router.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

const FOCUS = new Set(['polish', 'completeness', 'structure', 'runbook']);
const DECISIONS = new Set(['accept', 'reject', 'reset']);

/**
 * Adds the routes that review or improve a page and everything under it (ADR-024). Improving fills a
 * queue of proposals; only the pages a person accepts are checked and pushed, one at a time, each
 * against the version its proposal was made from.
 *
 * @param router The router to add to.
 * @param services What the routes share.
 */
export function addBranchRoutes(router: Router, services: Services): Router {
  const { branches } = services;
  return (
    router
      .add('POST', '/api/branches/runs', async ({ body }): Promise<BranchRun> => {
        const fields = fieldsOf(body);
        const kind = fields.kind;
        if (kind !== 'review' && kind !== 'improve') throw new HttpError(400, 'kind must be review or improve');
        const spaceKey = optionalString(body, 'spaceKey');
        const pageId = typeof fields.pageId === 'number' ? String(fields.pageId) : optionalString(body, 'pageId');
        if (!isValidSpaceKey(spaceKey) || !isValidPageId(pageId))
          throw new HttpError(400, 'spaceKey and pageId are required');
        const focus = optionalString(body, 'focus');
        if (focus !== undefined && !FOCUS.has(focus)) throw new HttpError(400, 'unknown focus');
        const input = {
          spaceKey: spaceKey.toUpperCase(),
          rootPageId: pageId,
          focus,
          instructions: optionalString(body, 'instructions')?.slice(0, 2000),
        };
        return kind === 'improve' ? branches.startImprove(input) : branches.startReview(input);
      })
      .add('GET', '/api/branches/runs', ({ query }) => {
        const runs = branches.store.list(query.get('spaceKey')?.toUpperCase(), query.get('pageId') ?? undefined);
        return {
          runs: runs.map(({ items, findings, reportText, ...run }) => ({
            ...run,
            pages: items.length || run.total,
            findings: findings?.length,
            hasReport: reportText !== undefined,
          })),
        };
      })
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
