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

import type { PageDetail, PageTreeNode } from '../api/types.js';
import { loadGuardRules, OutboundGuard } from '../ai/guard.js';
import { runLimited } from '../util/runLimited.js';
import type { ManifestBuilder } from '../ai/manifest.js';
import type { GateDeps } from './aiGate.js';

/** How much page text one AI request may carry, so a large branch cannot exceed what a model accepts. */
export const CONTEXT_CHAR_LIMIT = 400_000;

export type BranchPage = { page: PageDetail; markdown: string };

export type BranchContext = {
  /** The pages that may be sent, in tree order. */
  pages: BranchPage[];
  /** Pages left out because they hold a secret (ADR-022). */
  withheld: string[];
  /** Pages left out because the context was already full. */
  overflow: string[];
  /** How many pages were left out because the exclusion rules exclude them; never which. */
  excluded: number;
};

/**
 * Decides, one page at a time, which pages may join an AI request. Excluded pages are left out
 * without being named, because even their titles must not be sent. Pages holding a secret are left
 * out and named, so a person knows why. Once the size limit is reached, the remaining pages are named
 * as left out.
 *
 * @param spaceKey The space the pages belong to.
 * @param deps Where the exclusion rules come from.
 * @param dataDir The data directory, for the space's guard rules.
 * @param budget How many characters the collected pages may take.
 */
export function contextCollector(
  spaceKey: string,
  deps: Pick<GateDeps, 'exclusions'> & { store: Pick<GateDeps['store'], 'readableMarkdown'> },
  dataDir: string,
  budget = CONTEXT_CHAR_LIMIT,
): { consider: (page: PageDetail) => void; result: BranchContext } {
  const screen = new OutboundGuard(loadGuardRules(dataDir, spaceKey));
  const result: BranchContext = { pages: [], withheld: [], overflow: [], excluded: 0 };
  let used = 0;
  const consider = (page: PageDetail): void => {
    if (deps.exclusions.isPageExcluded(page, spaceKey || page.spaceKey)) {
      result.excluded++;
      return;
    }
    // The page with its text attachments, so the guard and the size limit see both (ADR-066).
    const markdown = deps.store.readableMarkdown(spaceKey || page.spaceKey, page);
    if (screen.secretsIn(markdown).length > 0) result.withheld.push(page.title);
    else if (used + markdown.length > budget) result.overflow.push(page.title);
    else {
      used += markdown.length;
      result.pages.push({ page, markdown });
    }
  };
  return { consider, result };
}

/**
 * Collects the pages below a page that may be sent to an AI, each checked by `contextCollector`. The
 * synced copy is used when the branch is on disk, otherwise Confluence is read.
 *
 * @param pageId The page whose descendants to collect.
 * @param spaceKey The space it belongs to.
 * @param deps Where pages and rules come from.
 * @param dataDir The data directory, for the space's guard rules.
 * @param budget How many characters the collected pages may take.
 */
export async function collectBranch(
  pageId: string,
  spaceKey: string,
  deps: GateDeps,
  dataDir: string,
  budget = CONTEXT_CHAR_LIMIT,
): Promise<BranchContext> {
  const { consider, result } = contextCollector(spaceKey, deps, dataDir, budget);
  const synced = deps.store.descendants(spaceKey, pageId);
  if (synced.length > 0) {
    for (const node of synced) {
      const page = deps.store.readPage(spaceKey, node.id);
      if (page) consider(page);
    }
    return result;
  }

  const client = deps.client();
  const [root] = await client.getPageTree(spaceKey, pageId);
  const flat = (nodes: PageTreeNode[]): PageTreeNode[] => nodes.flatMap((n) => [n, ...flat(n.children)]);
  const pages = await runLimited(
    flat(root?.children ?? []).map((node) => async (): Promise<PageDetail | undefined> => {
      try {
        return await client.getPageDetail(node.id);
      } catch {
        // A page that cannot be read is left out, so its content is never sent.
        return undefined;
      }
    }),
    4,
  );
  for (const page of pages) if (page) consider(page);
  return result;
}

/** The note an answer carries about pages left out of its context to fit the size limit. */
export function leftOutNote(branch: Pick<BranchContext, 'overflow'>): string {
  return branch.overflow.length > 0 ? ` Left out to fit the request size: ${branch.overflow.join(', ')}.` : '';
}

/**
 * Formats collected pages as context, each marked in the manifest, and records the pages left out
 * with why: excluded (counted, never named), holding a secret, or past the size limit.
 */
export function pagesAsContext(collected: BranchContext, manifest: ManifestBuilder): string {
  for (const title of collected.withheld) manifest.leaveOut('page', title, 0, 'secret');
  for (const title of collected.overflow) manifest.leaveOut('page', title, 0, 'over-limit');
  for (let i = 0; i < collected.excluded; i++) manifest.leaveOut('page', '', 0, 'excluded');
  return collected.pages
    .map((p) => manifest.include('page', p.page.title, `## [Page: ${p.page.title}]\n${p.markdown}`))
    .join('\n\n---\n\n');
}
