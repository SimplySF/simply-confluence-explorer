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

// A plan for searching a corpus too large for one request (ADR-079, design doc 0017). The corpus's
// directories are shown to the model as a numbered map, and it chooses the areas to search, each with
// what to look for there. The map is built from the visible tree and only names pages that are both
// in the corpus and allowed by the exclusion rules, so nothing else reaches the planning request.

import type { DirectoryDigest, PageDetail, PageTreeNode } from '../api/types.js';
import type { AiEngine } from '../ai/engine.js';
import type { ManifestBuilder, PlanRecord } from '../ai/manifest.js';
import { askStructured, chosenByNumber, type StructuredPrompt } from '../ai/structured.js';
import type { Tracer } from '../telemetry/tracer.js';
import type { ExclusionManager } from './exclusionManager.js';
import { seriesKey, seriesOf } from './spaceMap.js';
import type { SpaceStore } from './spaceStore.js';

/** A page of the corpus with pages of the corpus below it. */
export type MapDir = {
  id: string;
  title: string;
  /** The titles of the directories of the corpus above it. */
  path: string[];
  /** It and every page of the corpus below it. */
  pages: string[];
  children: MapDir[];
};

/** An area the plan searches, and the words to look for there. */
export type PlanArea = { dir: MapDir; look: string; why?: string };

export type PlanDeps = {
  store: SpaceStore;
  exclusions: ExclusionManager;
  ai?: Pick<AiEngine, 'analyzeDocument'>;
  digest?: (spaceKey: string, dirId: string) => DirectoryDigest | undefined;
  signal?: AbortSignal;
  tracer?: Tracer;
};

/** The most areas a plan searches. */
export const MAX_AREAS = 6;
/** The most times the map is shown, each time below the areas chosen the time before. */
const ROUNDS = 3;

/**
 * The corpus's directories as trees: a page of the corpus that has pages of the corpus below it. A
 * page outside the corpus is passed through but never named, and an excluded page is dropped with
 * everything below it, as the visible tree already does.
 */
export async function corpusDirectories(key: string, corpus: PageDetail[], deps: PlanDeps): Promise<MapDir[]> {
  await deps.store.treeReady(key);
  const inCorpus = new Set(corpus.map((p) => p.id));
  const excluded = deps.exclusions.checker(key);
  const walk = (
    node: PageTreeNode,
    ancestors: Array<{ id: string; title: string }>,
    path: string[],
  ): { pages: string[]; dirs: MapDir[] } => {
    if (excluded({ id: node.id, title: node.title, ancestors })) return { pages: [], dirs: [] };
    const member = inCorpus.has(node.id);
    const below = node.children.map((c) =>
      walk(c, [...ancestors, { id: node.id, title: node.title }], member ? [...path, node.title] : path),
    );
    const pages = below.flatMap((b) => b.pages);
    const dirs = below.flatMap((b) => b.dirs);
    if (!member) return { pages, dirs };
    if (pages.length === 0) return { pages: [node.id], dirs: [] };
    return {
      pages: [node.id, ...pages],
      dirs: [{ id: node.id, title: node.title, path, pages: [node.id, ...pages], children: dirs }],
    };
  };
  return deps.store.tree(key).flatMap((root) => walk(root, [], []).dirs);
}

/** Every directory of the trees, each once. */
export const allDirs = (roots: MapDir[]): MapDir[] => roots.flatMap((d) => [d, ...allDirs(d.children)]);

/** The longest description of a directory without a digest. */
const DESCRIPTION_CHARS = 300;

/**
 * The titles of the directories below one, as many as fit in `room` characters: those with names of
 * their own first, nearest first, then each set of titles that differ only in numbers and dates,
 * named once with a count. A deep area's name is then not crowded out by a hundred numbered siblings.
 */
function areasBelow(dir: MapDir, room: number): string {
  const named: string[] = [];
  const series = new Map<string, { title: string; count: number }>();
  for (const queue = [...dir.children], d = { at: 0 }; d.at < queue.length; d.at++) {
    const below = queue[d.at];
    const key = seriesKey(below.title);
    if (!key.includes('#')) named.push(below.title);
    else series.set(key, { title: below.title, count: (series.get(key)?.count ?? 0) + 1 });
    queue.push(...below.children);
  }
  const all = [
    ...named,
    ...[...series.values()].map((s) => (s.count > 1 ? `${s.title} (+${s.count - 1} like it)` : s.title)),
  ];
  let used = 0;
  return all.filter((t) => (used += t.length + 2) <= room).join(', ');
}

/**
 * What a directory holds, in a line: its digest when it has a current one; otherwise its own
 * summary, the series most of its pages belong to, and the directories below it, or, with none, its
 * first pages.
 */
function describe(key: string, dir: MapDir, titles: Map<string, string>, deps: PlanDeps): string {
  // A digest describes the whole directory, so it is used only when the whole directory is in the corpus.
  const whole = deps.store.descendants(key, dir.id).length + 1 === dir.pages.length;
  const digest = whole ? deps.digest?.(key, dir.id) : undefined;
  if (digest) return `${digest.kind}: ${digest.summary}${digest.topics.length ? ` (${digest.topics.join(', ')})` : ''}`;
  const parts: string[] = [];
  const summary = deps.store.readMetadata(key, dir.id)?.summary;
  if (summary) parts.push(summary);
  const series = seriesOf(dir.pages.slice(1).map((id) => titles.get(id) ?? ''));
  if (series) parts.push(`a series of ${series.pages} pages titled like "${series.pattern}"`);
  const room = DESCRIPTION_CHARS - parts.join('; ').length;
  if (dir.children.length) parts.push(`areas below: ${areasBelow(dir, room - 15)}`);
  else {
    const pages = dir.pages.slice(1).map((id) => titles.get(id));
    parts.push(`pages: ${pages.slice(0, 4).join(', ')}${pages.length > 4 ? ', …' : ''}`);
  }
  return parts.join('; ').slice(0, DESCRIPTION_CHARS);
}

/** A directory's line of the map, without its number. */
export function mapLine(key: string, dir: MapDir, titles: Map<string, string>, deps: PlanDeps): string {
  const place = [...dir.path, dir.title].join(' › ');
  return `${place} (${(dir.pages.length - 1).toLocaleString('en-US')} pages below): ${describe(key, dir, titles, deps)}`;
}

/**
 * The directories from `start` downwards, breadth first, as many as fit in `limit` characters, each
 * with its line. A directory is shown only after every directory above it.
 */
export function packMap(
  key: string,
  start: MapDir[],
  limit: number,
  titles: Map<string, string>,
  deps: PlanDeps,
): Array<{ dir: MapDir; line: string }> {
  const shown: Array<{ dir: MapDir; line: string }> = [];
  const queue = [...start];
  let used = 0;
  for (let dir = queue.shift(); dir; dir = queue.shift()) {
    const line = mapLine(key, dir, titles, deps);
    if (used + line.length + 6 > limit && shown.length > 0) break;
    shown.push({ dir, line });
    used += line.length + 6;
    queue.push(...dir.children);
  }
  return shown;
}

const planPrompt = (count: number): StructuredPrompt => ({
  task: 'You are choosing which areas of a Confluence space to search before answering a question.',
  rules: [
    `The message lists ${count} areas, numbered 1 to ${count}. Each line gives the area's place in the space, how many pages are below it, and what it holds.`,
    `Choose the areas most likely to hold the answer, at most ${MAX_AREAS}, most likely first. Use only numbers from 1 to ${count}. Prefer the most specific area that fits.`,
    'For each area give its "number", in "look" a few words to search for there, and in "why" why it may hold the answer, in a few words.',
    'If no area fits, reply {"areas":[]}.',
  ],
  example: '{"areas":[{"number":3,"look":"refund retry schedule","why":"the payments team owns refunds"}]}',
});

const planSchema = (count: number): Record<string, unknown> => ({
  type: 'object',
  properties: {
    areas: {
      type: 'array',
      maxItems: MAX_AREAS,
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer', minimum: 1, maximum: count },
          look: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['number', 'look'],
      },
    },
  },
  required: ['areas'],
});

/** The areas chosen in a parsed reply, or why the reply is not the choice asked for. */
export function parsePlan(json: unknown, offered: readonly MapDir[], question: string): PlanArea[] | string {
  const raw = (json as { areas?: unknown } | null)?.areas;
  const chosen = chosenByNumber(raw, offered, MAX_AREAS);
  if (typeof chosen === 'string') return chosen;
  const looks = new Map(
    (raw as Array<{ number?: unknown; look?: unknown }>).map((e) => [Number(e?.number), e?.look] as const),
  );
  return chosen.map(({ item, why }) => {
    const look = looks.get(offered.indexOf(item) + 1);
    return { dir: item, look: typeof look === 'string' && look.trim() ? look.slice(0, 200) : question, why };
  });
}

/**
 * The areas to search for a question, chosen by the model from the map. A map larger than `limit`
 * is shown from the top, then what lies below the areas chosen, at most three times; an area whose
 * whole subtree was shown is kept as chosen, and an area none of whose parts is chosen is kept whole. `null` when the first reply
 * could not be used after one repair, which the manifest names; a later reply that cannot be used
 * keeps the broader areas chosen before it.
 */
export async function planAreas(
  key: string,
  question: string,
  roots: MapDir[],
  titles: Map<string, string>,
  deps: PlanDeps,
  limit: number,
  manifest: ManifestBuilder,
): Promise<PlanArea[] | null> {
  if (!deps.ai) return null;
  const final: PlanArea[] = [];
  let start = roots;
  let previous: PlanArea[] = [];
  for (let round = 1; round <= ROUNDS && start.length > 0; round++) {
    const shown = packMap(key, start, limit, titles, deps);
    const offered = shown.map((s) => s.dir);
    const again =
      round > 1 ? 'These are the areas below the ones chosen before. If none fits better, reply {"areas":[]}.\n\n' : '';
    // eslint-disable-next-line no-await-in-loop -- each round shows what lies below the last round's choice
    const reply = await askStructured({
      ai: deps.ai,
      input: `Question: ${question}\n\n${again}Areas:\n${shown.map((s, i) => `${i + 1}. ${s.line}`).join('\n')}`,
      prompt: planPrompt(offered.length),
      schema: planSchema(offered.length),
      validate: (json) => parsePlan(json, offered, question),
      label: `Planning which areas of ${key} to search`,
      instead: round === 1 ? 'the whole corpus was searched at once' : 'the broader areas chosen before were searched',
      spaceKey: key,
      signal: deps.signal,
      manifest,
      tracer: deps.tracer,
    });
    if (!reply.ok && round === 1) return null;
    if (!reply.ok || reply.value.length === 0) break;
    const visible = new Set(offered.map((d) => d.id));
    const whole = (d: MapDir): boolean => allDirs(d.children).every((c) => visible.has(c.id));
    const last = round === ROUNDS;
    final.push(...reply.value.filter((a) => last || whole(a.dir)));
    previous = reply.value.filter((a) => !last && !whole(a.dir));
    start = previous.flatMap((a) => a.dir.children);
  }
  const seen = new Set<string>();
  return [...final, ...previous].filter((a) => !seen.has(a.dir.id) && !!seen.add(a.dir.id)).slice(0, MAX_AREAS);
}

/**
 * The plan as What was sent shows it: each area searched with why, and how many directories were not
 * searched, with the titles of the largest. A directory above a searched area counts as searched in part.
 */
export function planRecord(areas: PlanArea[], roots: MapDir[]): PlanRecord {
  const searched = new Set(areas.flatMap((a) => allDirs([a.dir]).map((d) => d.id)));
  const notSearched = allDirs(roots)
    .filter((d) => !searched.has(d.id) && !areas.some((a) => d.pages.includes(a.dir.id)))
    .sort((a, b) => b.pages.length - a.pages.length);
  return {
    searched: areas.map((a) => ({
      title: [...a.dir.path, a.dir.title].join(' › '),
      look: a.look,
      ...(a.why ? { why: a.why } : {}),
    })),
    notSearched: { count: notSearched.length, titles: notSearched.slice(0, 8).map((d) => d.title) },
  };
}
