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

import type { PageDetail, SpaceTocNode } from '../api/types.js';
import type { AiEngine } from '../ai/engine.js';
import { loadGuardRules, OutboundGuard } from '../ai/guard.js';
import { ManifestBuilder } from '../ai/manifest.js';
import { CONTEXT_CHAR_LIMIT, contextCollector, pagesAsContext } from './branchContext.js';
import type { ExclusionManager } from './exclusionManager.js';
import type { SearchIndex } from './searchIndex.js';
import { headingOf, sectionName, type Section } from './sections.js';
import type { SpaceStore } from './spaceStore.js';
import type { VectorIndex } from './vectors.js';

/** A section by its page and position; without a position, every section of the page. */
export type SectionRef = { pageId: string; index?: number };

export type ReadPage = {
  id: string;
  title: string;
  score: number;
  /** Why the AI chose it, when it chose. */
  why?: string;
  /** The sections read, when only some of the page was. */
  sections?: Array<{ index: number; heading: string }>;
};

export type RetrievedContext = {
  contextMarkdown: string;
  /** The pages read, which an answer names as its sources. */
  selectedPages: ReadPage[];
  /** Pages that matched but were left out because they hold a secret (ADR-022). */
  withheld: string[];
  /** Pages or sections that matched but did not fit within the size limit. */
  overflow: string[];
  /** How many candidate sections were looked at to choose these; 0 when the corpus was read in full. */
  considered: number;
  /** How many pages the chat reads from, and whether they were read in full or retrieved from. */
  corpus: { pages: number; mode: 'full' | 'retrieved' };
};

export type ContextQuery = {
  question: string;
  /** The question before it, so a follow-up such as "and how do we roll that back?" finds its sections. */
  previous?: string;
  /** Sections earlier answers read, kept so a conversation does not lose what it was reading. */
  keep?: SectionRef[];
};

export type RetrieverDeps = {
  store: SpaceStore;
  exclusions: ExclusionManager;
  index: SearchIndex;
  dataDir: string;
  vectors?: VectorIndex;
  ai?: Pick<AiEngine, 'analyzeDocument' | 'embed' | 'embeddingModel'>;
  signal?: AbortSignal;
};

/** Lets other requests run between the steps of answering one, so a large space never holds the server long. */
export const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** How many candidate sections the search offers the AI to choose from. */
const CANDIDATES = 40;
/** How many sections the AI may choose, and how many the search reads when it cannot choose. */
const CHOSEN = 12;
/** Reciprocal rank fusion's constant: a lower rank in one list still counts for something. */
const RRF_K = 60;

const CHOOSE_PROMPT = `You are choosing which sections of Confluence pages to read before answering a question.
The question, and the question before it if any, come first; then a catalogue of candidate sections, one per line, with each section's id, its page's title, the page's place in the space, the section's heading, and a summary.
Choose the sections that are needed to answer, at most ${CHOSEN}, most useful first. Reply with JSON only, in this shape:
{"sections":[{"id":"12345#2","why":"what this section adds"}]}`;

const refKey = (ref: { pageId: string; index: number }): string => `${ref.pageId}#${ref.index}`;
/** A page's place in the space, as its parents' titles. */
const pathOf = (page: PageDetail): string => page.ancestors.map((a) => a.title).join(' › ');

/** Reads the AI's choice of sections, keeping only ids it was offered; `null` when the reply is not the JSON asked for. */
export function parseChoice(text: string, offered: Set<string>): Array<{ id: string; why?: string }> | null {
  const json = /\{[\s\S]*\}/.exec(text);
  if (!json) return null;
  try {
    const raw = (JSON.parse(json[0]) as { sections?: unknown }).sections;
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

/** Merges rankings by reciprocal rank fusion, so a section high in either list rises. */
export function fuse(rankings: string[][], limit: number): string[] {
  const score = new Map<string, number>();
  for (const ranking of rankings)
    ranking.forEach((key, rank) => score.set(key, (score.get(key) ?? 0) + 1 / (RRF_K + rank + 1)));
  return [...score]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}

/** An outline of the space's top two levels, checked against the current rules, so an answer knows where things are. */
function outlineOf(key: string, deps: RetrieverDeps): string {
  let outline = '## Outline of the space\n';
  const walk = (nodes: SpaceTocNode[], depth: number, ancestors: Array<{ id: string; title: string }>): void => {
    const allowed = nodes.filter((n) => !deps.exclusions.isPageExcluded({ id: n.id, title: n.title, ancestors }, key));
    for (const n of allowed.slice(0, 8)) {
      outline += `${'  '.repeat(depth)}- **${n.title}**${n.summary ? `: ${n.summary}` : ''}\n`;
      if (depth < 1) walk(n.children, depth + 1, [...ancestors, { id: n.id, title: n.title }]);
    }
  };
  walk(deps.store.buildToc(key), 0, []);
  return `${outline}\n---\n\n`;
}

/**
 * About how many characters reading every page would take: each page's frontmatter and its sections
 * from the section index, each with its heading, so deciding whether a corpus fits does not convert
 * every page.
 */
export function corpusSize(spaceKey: string, pages: PageDetail[], index: SearchIndex): number {
  return index.sizeOf(spaceKey, pages);
}

type Candidate = { id: string; summary?: string; line: string };
type Chosen = Array<{ id: string; why?: string }>;

/**
 * Reads a corpus that fits in one request, each page checked by `contextCollector`; `null` when a page
 * would be left out for size after all, so the corpus is retrieved from rather than read in part.
 */
function readInFull(
  key: string,
  pages: PageDetail[],
  deps: RetrieverDeps,
  budget: number,
  manifest: ManifestBuilder,
): RetrievedContext | null {
  const { consider, result } = contextCollector(key, deps, deps.dataDir, budget);
  pages.forEach(consider);
  if (result.overflow.length > 0) return null;
  return {
    contextMarkdown:
      result.pages.length || result.withheld.length || result.excluded
        ? pagesAsContext(result, manifest)
        : 'No synced pages are available to read here.',
    selectedPages: result.pages.map((p) => ({ id: p.page.id, title: p.page.title, score: 1 })),
    withheld: result.withheld,
    overflow: result.overflow,
    considered: 0,
    corpus: { pages: pages.length, mode: 'full' },
  };
}

/** The corpus's best sections for the question, by keywords and, when the provider embeds, by meaning. */
async function candidatesFor(
  key: string,
  byId: Map<string, PageDetail>,
  text: string,
  deps: RetrieverDeps,
): Promise<Candidate[]> {
  const keyword = deps.index.searchSections(key, text, CANDIDATES, new Set(byId.keys())).map((h) => refKey(h.section));
  let semantic: string[] = [];
  const model = deps.ai?.embeddingModel?.();
  if (model && deps.ai?.embed && deps.vectors) {
    const [vector] = await deps.ai.embed([text], { spaceKey: key, signal: deps.signal });
    if (vector) semantic = deps.vectors.nearest([...byId.values()], vector, model, CANDIDATES).map(refKey);
  }
  return fuse([keyword, semantic], CANDIDATES).flatMap((id) => {
    const [pageId, index] = id.split('#');
    const section = sectionAt(key, deps, pageId, Number(index));
    const page = byId.get(pageId);
    if (!section || !page) return [];
    const meta = deps.store.readMetadata(key, pageId);
    // A section's own summary when it has one, otherwise its page's; an empty line counts as none.
    const summary = [meta?.sections?.[section.index]?.summary, meta?.summary].find(Boolean);
    const heading = headingOf(page.title, section);
    return [
      {
        id,
        summary,
        line: `${id} | ${page.title} | ${pathOf(page) || 'top level'} | ${heading} | ${summary ?? 'no summary'}`,
      },
    ];
  });
}

/** The AI's choice among the candidates, from their summaries, or `null` when it was not asked or not understood. */
async function choose(
  key: string,
  query: ContextQuery,
  candidates: Candidate[],
  deps: RetrieverDeps,
): Promise<Chosen | null> {
  if (!deps.ai || !candidates.some((c) => c.summary)) return null;
  const asked = `Question: ${query.question}${query.previous ? `\nThe question before it: ${query.previous}` : ''}`;
  const answer = await deps.ai.analyzeDocument(
    `${asked}\n\nCandidate sections:\n${candidates.map((c) => c.line).join('\n')}`,
    CHOOSE_PROMPT,
    `Choosing sections in ${key}`,
    { spaceKey: key, signal: deps.signal },
  );
  return parseChoice(answer.text, new Set(candidates.map((c) => c.id)));
}

function sectionAt(key: string, deps: RetrieverDeps, pageId: string, index: number): Section | undefined {
  return deps.index.sectionsOf(key, pageId).find((s) => s.index === index);
}

/**
 * Builds the context an AI receives for a question about a corpus: a page, a directory, chosen
 * pages or the whole space (ADR-051). A corpus that fits in one request is read in full. A larger
 * one is retrieved from: the section index (BM25) and, when the provider embeds, the section vectors
 * each rank the corpus's sections for the question and the one before it, and the two rankings are
 * fused. When the candidates have summaries, one request shows the AI their titles, places, headings
 * and summaries, never their text, and it chooses which to read; otherwise, or when its reply cannot
 * be read, the top of the fused ranking is read. The chosen sections, after those earlier answers
 * read, are checked by the secrets check and added until the size limit is reached.
 *
 * @param spaceKey The space.
 * @param pages The chat's corpus. An excluded page among them is still never sent: a full read checks
 * each page with `contextCollector`, and the section index holds no excluded page.
 * @param query The question and what the conversation carries.
 * @param deps The synced copy, the rules, the indexes, the guard rules' folder, and the AI.
 * @param options `budget` is how many characters the context may take; `outline` adds the space's outline.
 */
export async function retrieveContext(
  spaceKey: string,
  pages: PageDetail[],
  query: ContextQuery,
  deps: RetrieverDeps,
  options: { budget?: number; outline?: boolean; manifest?: ManifestBuilder } = {},
): Promise<RetrievedContext> {
  const key = spaceKey.toUpperCase();
  const budget = options.budget ?? CONTEXT_CHAR_LIMIT;
  const manifest = options.manifest ?? new ManifestBuilder();
  const whole = corpusSize(key, pages, deps.index) <= budget ? readInFull(key, pages, deps, budget, manifest) : null;
  if (whole) return whole;

  await pause();
  const byId = new Map(pages.map((p) => [p.id, p]));
  const candidates = await candidatesFor(key, byId, [query.question, query.previous].filter(Boolean).join(' '), deps);
  let chosen: Chosen =
    (await choose(key, query, candidates, deps)) ?? candidates.slice(0, CHOSEN).map((c) => ({ id: c.id }));
  // A question that matches nothing still gets an answer from a few pages, rather than none.
  if (chosen.length === 0 && !query.keep?.length)
    chosen = pages.slice(0, 3).flatMap((p) => {
      const first = deps.index.sectionsOf(key, p.id).at(0);
      return first ? [{ id: refKey(first) }] : [];
    });
  const kept = (query.keep ?? []).flatMap((ref) =>
    ref.index === undefined
      ? deps.index.sectionsOf(key, ref.pageId).map(refKey)
      : [refKey({ pageId: ref.pageId, index: ref.index })],
  );
  // The outline helps an answer place what it reads, but never at the cost of most of what it reads.
  await pause();
  const outlined = options.outline ? outlineOf(key, deps) : '';
  const outline = outlined.length <= budget / 4 ? outlined : '';
  const read = readSections(
    key,
    byId,
    [...kept, ...chosen.map((c) => c.id)],
    new Map(chosen.map((c) => [c.id, c.why])),
    deps,
    budget - outline.length,
    manifest,
  );
  return {
    ...read,
    contextMarkdown: `# Sections read from ${pages.length} pages\n\n${outline}${read.contextMarkdown}`,
    considered: candidates.length,
    corpus: { pages: pages.length, mode: 'retrieved' },
  };
}

/** Sends the sections in order, leaving out a page holding a secret, until the size limit. */
function readSections(
  key: string,
  byId: Map<string, PageDetail>,
  ids: string[],
  why: Map<string, string | undefined>,
  deps: RetrieverDeps,
  budget: number,
  manifest: ManifestBuilder,
): Pick<RetrievedContext, 'contextMarkdown' | 'selectedPages' | 'withheld' | 'overflow'> {
  const screen = new OutboundGuard(loadGuardRules(deps.dataDir, key));
  let used = 0;
  const read = new Map<string, { page: PageDetail; sections: Section[]; why?: string }>();
  const withheld = new Set<string>();
  const overflow: string[] = [];
  for (const id of new Set(ids)) {
    const [pageId, index] = id.split('#');
    const page = byId.get(pageId);
    const section = page && sectionAt(key, deps, pageId, Number(index));
    if (!page || !section) continue;
    const name = sectionName(page.title, section);
    if (screen.secretsIn(section.text).length > 0) withheld.add(page.title);
    else if (used + section.text.length + name.length > budget) overflow.push(name);
    else {
      used += section.text.length + name.length;
      const entry = read.get(pageId) ?? { page, sections: [] };
      entry.sections.push(section);
      entry.why ??= why.get(id);
      read.set(pageId, entry);
    }
  }
  const body = [...read.values()].map(({ page, sections }) => {
    const summary = deps.store.readMetadata(key, page.id)?.summary;
    const head = `## [Page: ${page.title}]\n_${pathOf(page) || 'Top level'}${summary ? ` · ${summary}` : ''}_`;
    const parts = sections
      .sort((a, b) => a.index - b.index)
      .map((s) =>
        manifest.include('section', sectionName(page.title, s), `### ${headingOf(page.title, s)}\n${s.text}`),
      );
    return [head, ...parts].join('\n\n');
  });
  for (const title of withheld) manifest.leaveOut('page', title, 0, 'secret');
  for (const name of overflow) manifest.leaveOut('section', name, 0, 'over-limit');
  return {
    contextMarkdown: body.join('\n\n---\n\n'),
    selectedPages: [...read.values()].map(({ page, sections, why: reason }) => ({
      id: page.id,
      title: page.title,
      score: 1,
      ...(reason ? { why: reason } : {}),
      sections: sections.map((s) => ({ index: s.index, heading: headingOf(page.title, s) })),
    })),
    withheld: [...withheld],
    overflow,
  };
}
