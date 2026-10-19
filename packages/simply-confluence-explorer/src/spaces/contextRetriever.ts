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

import type { SpaceTocNode } from '../api/types.js';
import { CONTEXT_CHAR_LIMIT, contextCollector } from './branchContext.js';
import type { ExclusionManager } from './exclusionManager.js';
import type { SearchIndex } from './searchIndex.js';
import type { SpaceStore } from './spaceStore.js';

export type SpaceContext = {
  contextMarkdown: string;
  /** The pages sent in full, which an answer names as its sources. */
  selectedPages: Array<{ id: string; title: string; score: number }>;
  /** Pages that matched but were left out because they hold a secret (ADR-022). */
  withheld: string[];
  /** Pages that matched but did not fit within the size limit. */
  overflow: string[];
};

export type SpaceQuery = {
  question: string;
  /** The question before it, so a follow-up such as "and how do we roll that back?" finds its pages. */
  previous?: string;
  /** Pages earlier turns used, kept so a conversation does not lose what it was reading. */
  keep?: string[];
};

/** How many pages a search adds, before the size limit decides how many of them fit. */
const SEARCH_LIMIT = 12;

/**
 * Builds the context an AI receives for a question about a whole space: an outline of the space, then
 * the full text of the pages that matter, in this order: the pages earlier turns used, and the pages the search index ranks highest for the question (BM25 over titles,
 * tags, summaries and text). Each page is checked against the exclusion rules and the secrets check,
 * and pages are added until the size limit is reached. The outline is checked against the current
 * rules rather than trusted as written, because the table of contents on disk may predate a rule.
 *
 * @param spaceKey The space.
 * @param query The question and what the conversation carries.
 * @param deps The synced copy, the exclusion rules, the search index, and the data directory for the guard rules.
 * @param budget How many characters the context may take.
 */
export function retrieveSpaceContext(
  spaceKey: string,
  query: SpaceQuery,
  deps: { store: SpaceStore; exclusions: ExclusionManager; index: SearchIndex; dataDir: string },
  budget = CONTEXT_CHAR_LIMIT,
): SpaceContext {
  const key = spaceKey.toUpperCase();
  if (!deps.store.isSynced(key))
    return {
      contextMarkdown: 'No synced pages are available in this space.',
      selectedPages: [],
      withheld: [],
      overflow: [],
    };

  let outline = '## Outline of the space\n';
  const walk = (nodes: SpaceTocNode[], depth: number, ancestors: Array<{ id: string; title: string }>): void => {
    const allowed = nodes.filter((n) => !deps.exclusions.isPageExcluded({ id: n.id, title: n.title, ancestors }, key));
    for (const n of allowed.slice(0, 8)) {
      outline += `${'  '.repeat(depth)}- **${n.title}**${n.summary ? `: ${n.summary}` : ''}\n`;
      walk(n.children, depth + 1, [...ancestors, { id: n.id, title: n.title }]);
    }
  };
  walk(deps.store.buildToc(key), 0, []);

  const scores = new Map<string, number>();
  const order: string[] = [];
  const add = (id: string, score: number): void => {
    if (scores.has(id)) return;
    scores.set(id, score);
    order.push(id);
  };
  for (const id of query.keep ?? []) add(id, 1);
  const text = [query.question, query.previous].filter(Boolean).join(' ');
  for (const hit of deps.index.search(key, text, SEARCH_LIMIT)) add(hit.pageId, Math.round(hit.score * 100) / 100);
  // A question that matches nothing still gets an answer from a few pages, rather than none.
  if (order.length === 0) for (const page of deps.store.visiblePages(key).slice(0, 3)) add(page.id, 0);

  const { consider, result } = contextCollector(key, deps, deps.dataDir, budget - outline.length);
  for (const id of order) {
    const page = deps.store.readPage(key, id);
    if (page) consider(page);
  }
  const body = result.pages.map((p) => `## [Document: ${p.page.title}]\n${p.markdown}\n\n---\n\n`).join('');
  return {
    contextMarkdown: `# Relevant Confluence pages (${result.pages.length} matched)\n\n${outline}\n---\n\n${body}`,
    selectedPages: result.pages.map((p) => ({ id: p.page.id, title: p.page.title, score: scores.get(p.page.id) ?? 0 })),
    withheld: result.withheld,
    overflow: result.overflow,
  };
}
