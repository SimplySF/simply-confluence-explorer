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

import type { PageDetail } from '../api/types.js';
import type { ConfluenceClient } from '../confluence/client.js';
import type { ExclusionManager } from './exclusionManager.js';
import type { SpaceStore } from './spaceStore.js';

export type AiGateResult = {
  allowed: boolean;
  spaceKey: string;
  page?: PageDetail;
  reason?: string;
};

export const EXCLUDED_MESSAGE = "This page is excluded from AI by the space's .confluenceignore rules.";

export type GateDeps = { store: SpaceStore; exclusions: ExclusionManager; client: () => ConfluenceClient };

/**
 * Decides whether a page may be sent to an AI (ADR-018). The synced copy is checked when there is
 * one, otherwise the page is read from Confluence. It fails closed: a page that cannot be looked up
 * is not sent, because a page nobody can read cannot be shown not to be excluded.
 *
 * @param pageId The page to check.
 * @param spaceKey The space it belongs to, when the caller knows it.
 * @param deps Where pages and rules come from.
 */
export async function gatePageForAi(
  pageId: string,
  spaceKey: string | undefined,
  deps: GateDeps,
): Promise<AiGateResult> {
  let key = (spaceKey ?? deps.store.findSpaceKey(pageId) ?? '').toUpperCase();
  let page = key ? deps.store.readPage(key, pageId) : undefined;
  if (!page) {
    try {
      page = await deps.client().getPageDetail(pageId);
    } catch {
      // Unreadable: refused below, with the reason, rather than sent unchecked.
      return {
        allowed: false,
        spaceKey: key,
        reason: 'The page could not be looked up, so its exclusion rules could not be checked.',
      };
    }
  }
  key ||= page.spaceKey.toUpperCase();
  if (deps.exclusions.isPageExcluded(page, key))
    return { allowed: false, spaceKey: key, page, reason: EXCLUDED_MESSAGE };
  return { allowed: true, spaceKey: key, page };
}
