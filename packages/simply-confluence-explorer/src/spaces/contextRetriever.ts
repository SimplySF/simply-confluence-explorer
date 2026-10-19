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
import type { AiEngine } from '../ai/engine.js';
import { CONTEXT_CHAR_LIMIT, contextCollector } from './branchContext.js';
import type { ExclusionManager } from './exclusionManager.js';
import type { SearchIndex } from './searchIndex.js';
import type { SpaceStore } from './spaceStore.js';

export type SpaceContext = {
  contextMarkdown: string;
  /** The pages sent in full, which an answer names as its sources. */
  selectedPages: Array<{ id: string; title: string; score: number; why?: string }>;
  /** Pages that matched but were left out because they hold a secret (ADR-022). */
  withheld: string[];
  /** Pages that matched but did not fit within the size limit. */
  overflow: string[];
  /** How many candidate pages were looked at to choose these. */
  considered: number;
};

export type SpaceQuery = {
  question: string;
  /** The question before it, so a follow-up such as "and how do we roll that back?" finds its pages. */
  previous?: string;
  /** Pages earlier turns used, kept so a conversation does not lose what it was reading. */
  keep?: string[];
};

/** How many candidates the search offers the AI to choose from. */
const CANDIDATES = 25;
/** How many pages the AI may choose to read in full, and how many the search reads when it cannot choose. */
const CHOSEN = 8;

const CHOOSE_PROMPT = `You are choosing which Confluence pages to read before answering a question about a space.
The question, and the question before it if any, come first; then a catalogue of candidate pages, one per line, with each page's id, title, place in the space and summary.
Choose the pages that are needed to answer, at most ${CHOSEN}, most useful first. Reply with JSON only, in this shape:
{"pages":[{"id":"12345","why":"what this page adds"}]}`;

type Candidate = { id: string; title: string; path: string; summary?: string; line: string };

/** A page's place in the space, as its parents' titles. */
const pathOf = (ancestors: Array<{ title: string }>): string => ancestors.map((a) => a.title).join(' › ');

/** Reads the AI's choice of pages, keeping only ids it was offered; `null` when the reply is not the JSON asked for. */
export function parseChoice(text: string, offered: Set<string>): Array<{ id: string; why?: string }> | null {
  const json = /\{[\s\S]*\}/.exec(text);
  if (!json) return null;
  try {
    const raw = (JSON.parse(json[0]) as { pages?: unknown }).pages;
    if (!Array.isArray(raw)) return null;
    return raw
      .map((p: unknown) => (p ?? {}) as { id?: unknown; why?: unknown })
      .filter((p): p is { id: string; why?: unknown } => typeof p.id === 'string' && offered.has(p.id))
      .map((p) => ({ id: p.id, why: typeof p.why === 'string' ? p.why.slice(0, 200) : undefined }))
      .slice(0, CHOSEN);
  } catch {
    // Not JSON after all: the caller reads the top search results instead.
    return null;
  }
}

/**
 * Builds the context an AI receives for a question about a whole space (ADR-048). The search index
 * (BM25 over titles, tags, summaries and text) finds candidates for the question and the one before
 * it. When the candidates have AI summaries, one request shows the AI their titles, places and
 * summaries, never their text, and it chooses which to read; otherwise, or when its reply cannot be
 * read, the top search results are read. The chosen pages, after the pages earlier answers used, are
 * checked against the exclusion rules and the secrets check and added until the size limit is
 * reached, after an outline of the space checked against the current rules.
 *
 * @param spaceKey The space.
 * @param query The question and what the conversation carries.
 * @param deps The synced copy, the rules, the search index, the guard rules' folder, and the AI that chooses.
 * @param budget How many characters the context may take.
 */
export async function retrieveSpaceContext(
  spaceKey: string,
  query: SpaceQuery,
  deps: {
    store: SpaceStore;
    exclusions: ExclusionManager;
    index: SearchIndex;
    dataDir: string;
    ai?: Pick<AiEngine, 'analyzeDocument'>;
    signal?: AbortSignal;
  },
  budget = CONTEXT_CHAR_LIMIT,
): Promise<SpaceContext> {
  const key = spaceKey.toUpperCase();
  if (!deps.store.isSynced(key))
    return {
      contextMarkdown: 'No synced pages are available in this space.',
      selectedPages: [],
      withheld: [],
      overflow: [],
      considered: 0,
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

  const text = [query.question, query.previous].filter(Boolean).join(' ');
  // The search reads only pages the exclusion rules allow, so an excluded page is never a candidate.
  const candidates: Candidate[] = deps.index.search(key, text, CANDIDATES).flatMap((hit) => {
    const page = deps.store.readPage(key, hit.pageId);
    if (!page) return [];
    const meta = deps.store.readMetadata(key, page.id);
    const facts = [meta?.documentType, meta?.tags.join(', '), meta?.systemsMentioned.join(', ')].filter(Boolean);
    const path = pathOf(page.ancestors);
    return [
      {
        id: page.id,
        title: page.title,
        path,
        summary: meta?.summary,
        line: `${page.id} | ${page.title} | ${path || 'top level'} | ${meta?.summary ?? 'no summary'}${facts.length ? ` | ${facts.join(' | ')}` : ''}`,
      },
    ];
  });

  let chosen: Array<{ id: string; why?: string }> | null = null;
  if (deps.ai && candidates.some((c) => c.summary)) {
    const asked = `Question: ${query.question}${query.previous ? `\nThe question before it: ${query.previous}` : ''}`;
    const answer = await deps.ai.analyzeDocument(
      `${asked}\n\nCandidate pages:\n${candidates.map((c) => c.line).join('\n')}`,
      CHOOSE_PROMPT,
      `Choosing pages in ${key}`,
      { spaceKey: key, signal: deps.signal },
    );
    chosen = parseChoice(answer.text, new Set(candidates.map((c) => c.id)));
  }
  chosen ??= candidates.slice(0, CHOSEN).map((c) => ({ id: c.id }));
  // A question that matches nothing still gets an answer from a few pages, rather than none.
  if (chosen.length === 0 && !query.keep?.length)
    chosen = deps.store
      .visiblePages(key)
      .slice(0, 3)
      .map((p) => ({ id: p.id }));

  const why = new Map(chosen.map((c) => [c.id, c.why]));
  const order = [...new Set([...(query.keep ?? []), ...chosen.map((c) => c.id)])];
  const { consider, result } = contextCollector(key, deps, deps.dataDir, budget - outline.length);
  for (const id of order) {
    const page = deps.store.readPage(key, id);
    if (page) consider(page);
  }
  const body = result.pages.map((p) => `## [Document: ${p.page.title}]\n${p.markdown}\n\n---\n\n`).join('');
  return {
    contextMarkdown: `# Relevant Confluence pages (${result.pages.length} read)\n\n${outline}\n---\n\n${body}`,
    selectedPages: result.pages.map((p) => ({
      id: p.page.id,
      title: p.page.title,
      score: 1,
      ...(why.get(p.page.id) ? { why: why.get(p.page.id) } : {}),
    })),
    withheld: result.withheld,
    overflow: result.overflow,
    considered: candidates.length,
  };
}
