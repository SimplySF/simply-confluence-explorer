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
import { loadGuardRules, OutboundGuard } from '../ai/guard.js';
import { parsePage } from '../parser/convert.js';
import type { ExclusionManager } from './exclusionManager.js';
import type { SpaceStore } from './spaceStore.js';

const STOP_WORDS = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being below between both ' +
    'but by can cannot could did do does doing down during each few for from further had has have having he her here ' +
    'hers herself him himself his how i if in into is it its itself let me more most my myself no nor not of off on once ' +
    'only or other ought our ours ourselves out over own same she should so some such than that the their theirs them ' +
    'themselves then there these they this those through to too under until up very was we were what when where which ' +
    'while who whom why with would you your yours yourself yourselves'
  ).split(' '),
);

export type SpaceContext = {
  contextMarkdown: string;
  selectedPages: Array<{ id: string; title: string; score: number }>;
  /** Pages that matched but were left out because they hold a secret (ADR-022). */
  withheld: string[];
};

/**
 * Chooses the synced pages of a space that best match a question, and builds the context an AI
 * receives for it: an outline of the space, then the full text of the best-matching pages. Pages are
 * scored on their titles, labels and AI summaries, so a large space is answered from a handful of
 * pages instead of all of them. Excluded pages are never considered, and the outline is checked
 * against the current rules rather than trusted as written, because the table of contents on disk
 * may predate a rule.
 *
 * @param spaceKey The space to search.
 * @param prompt The question.
 * @param deps The synced copy, the exclusion rules, and the data directory for the guard rules.
 * @param maxPages How many pages to include in full.
 */
export function retrieveSpaceContext(
  spaceKey: string,
  prompt: string,
  deps: { store: SpaceStore; exclusions: ExclusionManager; dataDir: string },
  maxPages = 4,
): SpaceContext {
  const key = spaceKey.toUpperCase();
  const pages = deps.store.visiblePages(key);
  if (pages.length === 0)
    return { contextMarkdown: 'No synced pages are available in this space.', selectedPages: [], withheld: [] };

  const tokens = prompt
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));

  const scored = pages
    .map((page) => {
      const meta = deps.store.readMetadata(key, page.id);
      const title = page.title.toLowerCase();
      const summary = (meta?.summary ?? '').toLowerCase();
      const tags = (meta?.tags ?? page.labels).map((t) => t.toLowerCase());
      const systems = (meta?.systemsMentioned ?? []).map((t) => t.toLowerCase());
      const score = tokens.reduce(
        (sum, token) =>
          sum +
          (title === token ? 15 : title.includes(token) ? 6 : 0) +
          (tags.includes(token) ? 8 : tags.some((t) => t.includes(token)) ? 4 : 0) +
          (systems.some((s) => s.includes(token)) ? 7 : 0) +
          (summary.includes(token) ? 3 : 0),
        0,
      );
      return { page, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPages);
  // A question that matches nothing still gets an answer from a few pages, rather than none.
  const chosen = scored.length > 0 ? scored : pages.slice(0, 3).map((page) => ({ page, score: 1 }));

  let context = `# Relevant Confluence pages (${chosen.length} matched)\n\n## Outline of the space\n`;
  const outline = (nodes: SpaceTocNode[], depth: number, ancestors: Array<{ id: string; title: string }>): void => {
    const allowed = nodes.filter((n) => !deps.exclusions.isPageExcluded({ id: n.id, title: n.title, ancestors }, key));
    for (const n of allowed.slice(0, 8)) {
      context += `${'  '.repeat(depth)}- **${n.title}**${n.summary ? `: ${n.summary}` : ''}\n`;
      outline(n.children, depth + 1, [...ancestors, { id: n.id, title: n.title }]);
    }
  };
  outline(deps.store.buildToc(key), 0, []);
  context += '\n---\n\n';

  // A page holding a secret is left out and named, so one page cannot block every question.
  const screen = new OutboundGuard(loadGuardRules(deps.dataDir, key));
  const withheld: string[] = [];
  const sent: Array<{ id: string; title: string; score: number }> = [];
  for (const { page, score } of chosen) {
    const { markdown } = parsePage(page);
    if (screen.secretsIn(markdown).length > 0) {
      withheld.push(page.title);
      continue;
    }
    context += `## [Document: ${page.title}]\n${markdown}\n\n---\n\n`;
    sent.push({ id: page.id, title: page.title, score });
  }
  return { contextMarkdown: context, selectedPages: sent, withheld };
}
