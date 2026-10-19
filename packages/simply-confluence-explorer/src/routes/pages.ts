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

import type { WriteResult } from '../api/types.js';
import { writePage } from '../confluence/pagePush.js';
import { HttpError, type Router } from '../http/router.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

const optionalNumber = (body: unknown, key: string): number | undefined => {
  const value = fieldsOf(body)[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new HttpError(400, `${key} must be a whole number`);
  return value;
};

/**
 * Adds the routes that write one page: check a change, and push it. A push names the version the
 * change was made from, and is refused if the page has changed since. An edit made by the app comes
 * from a review (ADR-046), whose run checks and pushes its pages the same way.
 *
 * @param router The router to add to.
 * @param services What the routes share.
 */
export function addPageRoutes(router: Router, services: Services): Router {
  const { store, client, log } = services;
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
    .add('POST', '/api/pages/:pageId/dry-run', ({ params, body }) => write(params.pageId, body, true))
    .add('POST', '/api/pages/:pageId/push', ({ params, body }) => write(params.pageId, body, false));
}
