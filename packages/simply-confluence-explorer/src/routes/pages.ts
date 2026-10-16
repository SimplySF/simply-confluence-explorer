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

import type { RecommendationResponse, WriteResult } from '../api/types.js';
import { improvePrompt, parseRecommendationResponse } from '../ai/improve.js';
import { writePage } from '../confluence/pagePush.js';
import { HttpError, type Router } from '../http/router.js';
import { parsePage } from '../parser/convert.js';
import { gatePageForAi } from '../spaces/aiGate.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

const optionalNumber = (body: unknown, key: string): number | undefined => {
  const value = fieldsOf(body)[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new HttpError(400, `${key} must be a whole number`);
  return value;
};

/**
 * Adds the routes that improve one page: ask the AI for a proposed revision, check it, and push it.
 * A proposal is made from the server's own copy of the page, after the exclusion check (ADR-037), and
 * carries the version it was made from, which the push must name.
 *
 * @param router The router to add to.
 * @param services What the routes share.
 */
export function addPageRoutes(router: Router, services: Services): Router {
  const { ai, store, exclusions, client, log } = services;
  const write = (pageId: string, body: unknown, dryRun: boolean): Promise<WriteResult> =>
    writePage(client(), store, log, {
      pageId,
      markdown: optionalString(body, 'markdown') ?? '',
      title: optionalString(body, 'title'),
      append: fieldsOf(body).append === true,
      baseVersion: optionalNumber(body, 'baseVersion'),
      spaceKey: optionalString(body, 'spaceKey')?.toUpperCase(),
      dryRun,
    });

  return router
    .add('POST', '/api/pages/:pageId/recommend', async ({ params, body }): Promise<RecommendationResponse> => {
      const gate = await gatePageForAi(params.pageId, optionalString(body, 'spaceKey'), { store, exclusions, client });
      if (!gate.allowed || !gate.page) throw new HttpError(403, gate.reason ?? 'This page cannot be sent to an AI.');
      const prompt = improvePrompt(optionalString(body, 'focusArea'), optionalString(body, 'prompt'));
      const answer = await ai.analyzeDocument(parsePage(gate.page).markdown, prompt, gate.page.title, {
        spaceKey: gate.spaceKey,
      });
      return { ...parseRecommendationResponse(answer.text), guard: answer.guard, baseVersion: gate.page.version };
    })
    .add('POST', '/api/pages/:pageId/dry-run', ({ params, body }) => write(params.pageId, body, true))
    .add('POST', '/api/pages/:pageId/push', ({ params, body }) => write(params.pageId, body, false));
}
