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

import type { BranchRun, ReviewAspect, ReviewSource } from '../api/types.js';
import { MAX_REVIEW_PAGES, REVIEW_ASPECTS } from '../branches/branchRuns.js';
import { isValidPageId, isValidSpaceKey } from '../http/guards.js';
import { HttpError, type Router } from '../http/router.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

const DECISIONS = new Set(['accept', 'reject', 'reset']);

const pageIdOf = (value: unknown): string | undefined =>
  typeof value === 'number' ? String(value) : typeof value === 'string' ? value : undefined;

/** How the pages were chosen, from a request: one page or a section by its root page, or a tag. */
function sourceFrom(value: unknown): ReviewSource {
  const fields = fieldsOf(value);
  if (fields.kind === 'page' || fields.kind === 'section') {
    const rootPageId = pageIdOf(fields.rootPageId);
    if (!isValidPageId(rootPageId)) throw new HttpError(400, 'a page or section review needs its rootPageId');
    return { kind: fields.kind, rootPageId };
  }
  throw new HttpError(400, 'source.kind must be page or section');
}

/** The chosen pages, from a request: between one and MAX_REVIEW_PAGES valid ids, each once. */
function pageIdsFrom(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REVIEW_PAGES)
    throw new HttpError(400, `choose between 1 and ${MAX_REVIEW_PAGES} pages`);
  const ids = value.map(pageIdOf);
  if (!ids.every(isValidPageId)) throw new HttpError(400, 'invalid page id');
  return [...new Set(ids)];
}

/** The aspects to look for, from a request; all of them when none are named. */
function aspectsFrom(value: unknown): ReviewAspect[] {
  if (value === undefined) return REVIEW_ASPECTS;
  if (!Array.isArray(value) || value.length === 0 || value.some((a) => !REVIEW_ASPECTS.includes(a as ReviewAspect)))
    throw new HttpError(400, `aspects must be some of: ${REVIEW_ASPECTS.join(', ')}`);
  return [...new Set(value as ReviewAspect[])];
}

/**
 * Adds the routes that review a set of pages and stage edits from the suggestions a person chose
 * (ADR-024, ADR-046). Only the pages a person accepts are checked and pushed, one at a time, each
 * against the version its edit was made from.
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
        const spaceKey = optionalString(body, 'spaceKey');
        if (!isValidSpaceKey(spaceKey)) throw new HttpError(400, 'spaceKey is required');
        return branches.startReview({
          spaceKey: spaceKey.toUpperCase(),
          source: sourceFrom(fields.source),
          pageIds: pageIdsFrom(fields.pageIds),
          aspects: aspectsFrom(fields.aspects),
          instructions: optionalString(body, 'instructions')?.slice(0, 2000),
        });
      })
      .add('POST', '/api/branches/runs/:runId/apply', ({ params, body }) => {
        const chosen = fieldsOf(body).findings;
        if (!Array.isArray(chosen) || chosen.some((i) => typeof i !== 'number'))
          throw new HttpError(400, 'findings must be a list of suggestion numbers');
        return branches.apply(params.runId, chosen as number[]);
      })
      .add('GET', '/api/branches/runs', ({ query }) => {
        const kind = query.get('source');
        const rootPageId = query.get('pageId') ?? '';
        const source: ReviewSource | undefined =
          (kind === 'page' || kind === 'section') && isValidPageId(rootPageId) ? { kind, rootPageId } : undefined;
        const runs = branches.store.list(query.get('spaceKey')?.toUpperCase(), source);
        return {
          runs: runs.map(({ items, findings, reportText, ...run }) => ({
            ...run,
            pages: items.length || Object.keys(run.pageIds ?? {}).length || run.total,
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
