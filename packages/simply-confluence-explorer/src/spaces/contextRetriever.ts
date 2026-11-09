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

import type { DirectoryDigest, PageDetail } from '../api/types.js';
import type { AiEngine } from '../ai/engine.js';
import { loadGuardRules, OutboundGuard } from '../ai/guard.js';
import { ManifestBuilder, summarise, type ManifestSummary } from '../ai/manifest.js';
import { askStructured, chosenByNumber, type StructuredPrompt } from '../ai/structured.js';
import type { Tracer } from '../telemetry/tracer.js';
import { pause } from '../util/pause.js';
import { fileKey } from './attachments.js';
import { CONTEXT_CHAR_LIMIT, contextCollector, pagesAsContext } from './branchContext.js';
import type { ExclusionManager } from './exclusionManager.js';
import { allDirs, corpusDirectories, packMap, planAreas, planRecord, type MapDir, type PlanArea } from './plan.js';
import type { SearchIndex } from './searchIndex.js';
import { headingOf, sectionName, type Section } from './sections.js';
import { seriesKey } from './spaceMap.js';
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
  /** The sections found share few of the question's words, so the answer may not be about it. */
  weak?: boolean;
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
  /** Told each step as it starts, so the person waiting can see how far the question has got. */
  onStep?: (step: string) => void;
  /** False when the chat reads pages only, so no attachment's section is sent (ADR-069). */
  attachments?: boolean;
  /** The attachments the person left out, by `fileKey`, whose sections are not sent either. */
  leftOut?: ReadonlySet<string>;
  /** Where a choice the AI could not make is logged and counted (ADR-079). */
  tracer?: Tracer;
  /** A directory's current digest, which describes it on the map a plan is made from (ADR-079). */
  digest?: (spaceKey: string, dirId: string) => DirectoryDigest | undefined;
};

/** How many candidate sections the search offers the AI to choose from. */
const CANDIDATES = 40;
/** How many sections a thorough answer reads, over as many requests as they need (design doc 0008). */
export const THOROUGH_SECTIONS = 150;
/** How many sections the AI may choose, and how many the search reads when it cannot choose. */
const CHOSEN = 12;
/** Reciprocal rank fusion's constant: a lower rank in one list still counts for something. */
const RRF_K = 60;
/** The share of a question's words the best section must hold for the match not to count as weak. */
const WEAK_COVER = 0.5;
/** The most candidates one directory, or one series of similar titles, may take of `CANDIDATES` (ADR-079). */
const GROUP_CAP = 8;

const choosePrompt = (count: number): StructuredPrompt => ({
  task: 'You are choosing which sections of Confluence pages to read before answering a question.',
  rules: [
    `The message lists ${count} candidate sections, numbered 1 to ${count}. Each line gives the page's title, its place in the space, the section's heading and a summary.`,
    'A line that ends "searched for: ..." was found in an area chosen for this question while looking for those words.',
    `Choose the sections needed to answer the question, at most ${CHOSEN}, most useful first. Use only numbers from 1 to ${count}.`,
    'For each section chosen, give its "number" and, in "why", what it adds to the answer in a few words.',
    'If no section helps, reply {"sections":[]}.',
  ],
  example: '{"sections":[{"number":4,"why":"the rollback steps"},{"number":11,"why":"who to call"}]}',
});

/** The reply's shape, for a provider that can be held to one. */
const chooseSchema = (count: number): Record<string, unknown> => ({
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      maxItems: CHOSEN,
      items: {
        type: 'object',
        properties: { number: { type: 'integer', minimum: 1, maximum: count }, why: { type: 'string' } },
        required: ['number'],
      },
    },
  },
  required: ['sections'],
});

const refKey = (ref: { pageId: string; index: number }): string => `${ref.pageId}#${ref.index}`;
/** A page's place in the space, as its parents' titles. */
const pathOf = (page: PageDetail): string => page.ancestors.map((a) => a.title).join(' › ');

/**
 * The AI's choice of sections from its parsed reply, each number mapped back to the id offered under
 * it and a number it was not offered dropped; a string saying why when the reply is not the choice asked for.
 */
export function parseChoice(json: unknown, offered: readonly string[]): Array<{ id: string; why?: string }> | string {
  const chosen = chosenByNumber((json as { sections?: unknown } | null)?.sections, offered, CHOSEN);
  if (typeof chosen === 'string') return chosen;
  return chosen.map((c) => ({ id: c.item, ...(c.why ? { why: c.why } : {}) }));
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

/** The groups a section's page counts toward under the diversity cap: its directory, and its series if it is in one. */
function groupsOf(byId: Map<string, PageDetail>, id: string): string[] {
  const page = byId.get(id.split('#')[0]);
  if (!page) return [];
  const series = seriesKey(page.title);
  return [`dir:${page.ancestors.at(-1)?.id ?? ''}`, ...(series.includes('#') ? [`series:${series}`] : [])];
}

/**
 * Takes from the rankings in turn, best first, until `limit`, so each ranking contributes; no
 * directory or series takes more than its share (`GROUP_CAP` in every `CANDIDATES`), so a large area
 * of similar pages cannot fill every place. Only when the cap leaves under a quarter of the places
 * filled, as in a corpus of one directory, do the sections it held back fill the rest.
 */
export function diversify(rankings: string[][], limit: number, groups: (id: string) => string[]): string[] {
  const cap = Math.max(1, Math.round((limit * GROUP_CAP) / CANDIDATES));
  const out: string[] = [];
  const seen = new Set<string>();
  const held: string[] = [];
  const counts = new Map<string, number>();
  const cursors = rankings.map(() => 0);
  while (out.length < limit && cursors.some((c, r) => c < rankings[r].length)) {
    for (let r = 0; r < rankings.length && out.length < limit; r++) {
      const id = rankings[r][cursors[r]++];
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const keys = groups(id);
      if (keys.some((k) => (counts.get(k) ?? 0) >= cap)) held.push(id);
      else {
        keys.forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1));
        out.push(id);
      }
    }
  }
  return out.length < limit / 4 ? [...out, ...held].slice(0, limit) : out;
}

/** The corpus's directories, as many as fit in `limit` from the top down, so an answer knows where things are. */
function outlineOf(
  key: string,
  roots: MapDir[],
  titles: Map<string, string>,
  deps: RetrieverDeps,
  limit: number,
): string {
  const shown = packMap(key, roots, limit - 100, titles, deps);
  return shown.length ? `## Map of the directories\n${shown.map((d) => `- ${d.line}`).join('\n')}\n\n---\n\n` : '';
}

/**
 * The plan for a corpus that spans more than one directory, recorded in the manifest, with the
 * directories it was made from; no areas when the AI is not asked or its first reply could not be used.
 */
async function planFor(
  key: string,
  pages: PageDetail[],
  query: ContextQuery,
  deps: RetrieverDeps,
  budget: number,
  manifest: ManifestBuilder,
): Promise<{ areas: PlanArea[]; roots: MapDir[]; titles: Map<string, string> }> {
  const roots = await corpusDirectories(key, pages, deps);
  const titles = new Map(pages.map((p) => [p.id, p.title]));
  if (!deps.ai || allDirs(roots).length < 2) return { areas: [], roots, titles };
  deps.onStep?.('Planning which areas to search');
  const asked = [query.question, query.previous && `(the question before it: ${query.previous})`]
    .filter(Boolean)
    .join(' ');
  const areas = await planAreas(key, asked, roots, titles, deps, budget / 4, manifest);
  if (areas) manifest.plan(planRecord(areas, roots));
  return { areas: areas ?? [], roots, titles };
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
  question: string,
  deps: RetrieverDeps,
  areas: PlanArea[],
): Promise<{ candidates: Candidate[]; weak: boolean }> {
  const { ranked, weak, lookedFor } = await rankSections(key, byId, text, question, deps, CANDIDATES, areas);
  const candidates = ranked.flatMap((id) => {
    const [pageId, index] = id.split('#');
    const section = sectionAt(key, deps, pageId, Number(index));
    const page = byId.get(pageId);
    if (!section || !page) return [];
    const meta = deps.store.readMetadata(key, pageId);
    // A section's own summary when it has one, otherwise its page's; an empty line counts as none.
    const summary = [meta?.sections?.[section.index]?.summary, meta?.summary].find(Boolean);
    const heading = headingOf(page.title, section);
    const looked = lookedFor.get(id);
    return [
      {
        id,
        summary,
        line: `${page.title} | ${pathOf(page) || 'top level'} | ${heading} | ${summary ?? 'no summary'}${
          looked ? ` | searched for: ${looked}` : ''
        }`,
      },
    ];
  });
  return { candidates, weak };
}

/**
 * The sections of each planned area that best match what the plan looks for there, at most `quota`.
 * An area no larger than its quota is offered whole, as the plan points at all of it.
 */
function areaRanking(
  key: string,
  byId: Map<string, PageDetail>,
  area: PlanArea,
  question: string,
  deps: RetrieverDeps,
  quota: number,
): string[] {
  const within = new Set(area.dir.pages.filter((id) => byId.has(id)));
  const found = deps.index.searchSections(key, `${area.look} ${question}`, quota, within).map((h) => refKey(h.section));
  if (within.size > quota) return found;
  const rest = [...within].flatMap((id) => deps.index.sectionsOf(key, id).map(refKey));
  return [...new Set([...found, ...rest])].slice(0, quota);
}

/**
 * The corpus's sections ranked for the question, by keywords and, when the provider embeds, by
 * meaning. With a plan, each area's own ranking takes its turn beside the whole corpus's, so that
 * half of the places are shared among the areas and each one contributes.
 */
async function rankSections(
  key: string,
  byId: Map<string, PageDetail>,
  text: string,
  question: string,
  deps: RetrieverDeps,
  limit: number,
  areas: PlanArea[] = [],
): Promise<{ ranked: string[]; weak: boolean; lookedFor: Map<string, string> }> {
  // Ranked deeper than `limit`, so the diversity cap has others to take in place of those it holds back.
  const deep = limit * 10;
  const hits = deps.index.searchSections(key, text, deep, new Set(byId.keys()));
  const keyword = hits.map((h) => refKey(h.section));
  let semantic: string[] = [];
  const model = deps.ai?.embeddingModel?.();
  if (model && deps.ai?.embed && deps.vectors) {
    const [vector] = await deps.ai.embed([text], { spaceKey: key, signal: deps.signal });
    if (vector) semantic = deps.vectors.nearest([...byId.values()], vector, model, deep).map(refKey);
  }
  // Weak when even the best section holds under half of this question's words, the one before it
  // aside, and nothing matched by meaning: the answer may rest on pages that are not about it.
  const best = deps.index.searchSections(key, question, 1, new Set(byId.keys()))[0];
  const weak = (best?.covers ?? 0) < WEAK_COVER && semantic.length === 0;
  const quota = Math.max(2, Math.floor(limit / 2 / Math.max(1, areas.length)));
  const byArea = areas.map((a) => areaRanking(key, byId, a, question, deps, quota));
  // What each section's area was searched for, so the choice knows why it was offered.
  const lookedFor = new Map<string, string>();
  byArea.forEach((ids, n) => ids.forEach((id) => lookedFor.has(id) || lookedFor.set(id, areas[n].look)));
  const ranked = diversify([...byArea, fuse([keyword, semantic], deep)], limit, (id) => groupsOf(byId, id));
  return { ranked, weak, lookedFor };
}

/**
 * The AI's choice among the candidates, offered by number with their summaries, or `null` when it was
 * not asked, or its reply could not be used after one repair, which the manifest then names.
 */
async function choose(
  key: string,
  query: ContextQuery,
  candidates: Candidate[],
  deps: RetrieverDeps,
  manifest: ManifestBuilder,
): Promise<Chosen | null> {
  if (!deps.ai || !candidates.some((c) => c.summary)) return null;
  deps.onStep?.(`Choosing among ${candidates.length} sections`);
  const asked = `Question: ${query.question}${query.previous ? `\nThe question before it: ${query.previous}` : ''}`;
  const ids = candidates.map((c) => c.id);
  const result = await askStructured({
    ai: deps.ai,
    input: `${asked}\n\nCandidate sections:\n${candidates.map((c, i) => `${i + 1}. ${c.line}`).join('\n')}`,
    prompt: choosePrompt(candidates.length),
    schema: chooseSchema(candidates.length),
    validate: (json) => parseChoice(json, ids),
    label: `Choosing sections in ${key}`,
    instead: `the ${Math.min(CHOSEN, candidates.length)} best search results were read`,
    spaceKey: key,
    signal: deps.signal,
    manifest,
    tracer: deps.tracer,
  });
  return result.ok ? result.value : null;
}

const searchStep = (pages: PageDetail[], areas: PlanArea[]): string =>
  areas.length
    ? `Searching ${areas.length} area${areas.length === 1 ? '' : 's'}`
    : `Searching ${pages.length.toLocaleString('en-US')} pages`;

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
 * be used after one repair, the top of the fused ranking is read and the manifest says so. The chosen
 * sections, after those earlier answers read, are checked by the secrets check and added until the
 * size limit is reached.
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
  const { areas, roots, titles } = await planFor(key, pages, query, deps, budget, manifest);
  deps.onStep?.(searchStep(pages, areas));
  const { candidates, weak } = await candidatesFor(
    key,
    byId,
    [query.question, query.previous].filter(Boolean).join(' '),
    query.question,
    deps,
    areas,
  );
  let chosen: Chosen =
    (await choose(key, query, candidates, deps, manifest)) ?? candidates.slice(0, CHOSEN).map((c) => ({ id: c.id }));
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
  const outlined = options.outline ? outlineOf(key, roots, titles, deps, budget / 4) : '';
  const outline = outlined.length <= budget / 4 ? outlined : '';
  deps.onStep?.('Reading the chosen sections');
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
    ...(weak ? { weak } : {}),
  };
}

/**
 * The sections a thorough answer reads, as batches that each fit one request, and what its plan
 * recorded: the areas searched, and a plan whose reply could not be used.
 */
export type SectionBatches = { batches: string[][]; sections: number; weak: boolean; planned: ManifestSummary };

/**
 * Ranks up to `THOROUGH_SECTIONS` of the corpus's sections for the question, across the areas a plan
 * chooses as `retrieveContext` does, and packs them into
 * batches of at most `budget` characters. A page's sections are kept together, in the order its best
 * section ranked, so a batch reads whole stretches of a page rather than scattered pieces. Each batch
 * is read later with `readBatch`, which checks every section again before it is sent.
 */
export async function sectionBatches(
  spaceKey: string,
  pages: PageDetail[],
  query: ContextQuery,
  deps: RetrieverDeps,
  budget: number,
): Promise<SectionBatches> {
  const key = spaceKey.toUpperCase();
  const byId = new Map(pages.map((p) => [p.id, p]));
  const manifest = new ManifestBuilder();
  const { areas } = await planFor(key, pages, query, deps, budget, manifest);
  deps.onStep?.(searchStep(pages, areas));
  const text = [query.question, query.previous].filter(Boolean).join(' ');
  const { ranked, weak } = await rankSections(key, byId, text, query.question, deps, THOROUGH_SECTIONS, areas);
  const byPage = new Map<string, Section[]>();
  for (const id of ranked) {
    const [pageId, index] = id.split('#');
    const section = sectionAt(key, deps, pageId, Number(index));
    const page = byId.get(pageId);
    if (section && page) byPage.set(pageId, [...(byPage.get(pageId) ?? []), section]);
  }
  const batches: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const [pageId, sections] of byPage) {
    const title = byId.get(pageId)!.title;
    for (const s of sections.sort((a, b) => a.index - b.index)) {
      const size = s.text.length + sectionName(title, s).length;
      if (used > 0 && used + size > budget) {
        batches.push(current);
        current = [];
        used = 0;
      }
      current.push(refKey(s));
      used += size;
    }
  }
  if (current.length) batches.push(current);
  return {
    batches,
    sections: batches.reduce((n, b) => n + b.length, 0),
    weak,
    planned: summarise(manifest.build()),
  };
}

/** One batch of a thorough answer, as context: each section checked by the secrets check, until `budget`. */
export function readBatch(
  spaceKey: string,
  pages: PageDetail[],
  ids: string[],
  deps: RetrieverDeps,
  budget: number,
  manifest: ManifestBuilder,
): Pick<RetrievedContext, 'contextMarkdown' | 'selectedPages' | 'withheld' | 'overflow'> {
  const byId = new Map(pages.map((p) => [p.id, p]));
  return readSections(spaceKey.toUpperCase(), byId, ids, new Map(), deps, budget, manifest);
}

/** Whether a section is an attachment the chat reads pages only without, or one the person left out. */
function leftOutSection(deps: RetrieverDeps, pageId: string, section: Section): boolean {
  const attachment = section.path.find((h) => h.startsWith('Attachment: '));
  if (!attachment) return false;
  return deps.attachments === false || !!deps.leftOut?.has(fileKey(pageId, attachment.slice('Attachment: '.length)));
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
    if (leftOutSection(deps, pageId, section)) continue;
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
