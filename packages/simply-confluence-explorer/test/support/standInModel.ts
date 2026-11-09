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

// A STAND-IN for the model, not a model. It answers the two structured requests of a retrieved
// question, planning which areas to search and choosing which sections to read, the way a careful
// reader would who understood nothing but shared words. A line scores by the question's words it
// holds, each counted less the more lines hold it, as a reader skims past what every line says; a
// word in the line's own title counts double; and a long line counts less than a short one that
// holds as much, as a list of keywords says little about any of them. It plans the areas that score
// at least half as well as the best, at most three, preferring the more specific of two equal ones.
// It chooses sections the same way, a little more readily from an area the plan searched, and
// passes over a section whose summary repeats one it has chosen. It lets the retrieval measurement
// run without a real AI, and shows whether the map and the candidates carry what a model would need.

import type { AiEngine } from '../../src/ai/engine.js';

/** Common words, and the words the map and the candidate list use to label their own parts. */
const STOP = new Set(
  'a an and are as at be by can do does for from get has have how in is it of on or that the this to we what when where which who why with area areas below page pages series titled like part top level summary'.split(
    ' ',
  ),
);

/** The words of a text, lowercase, without common words, and with a plural's last "s" removed. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)),
  );
}

const shared = (a: Set<string>, b: Set<string>): string[] => [...a].filter((w) => b.has(w));

type Line = { number: number; title: string; rest: string; summary: string; planned: boolean; depth: number };

/**
 * The numbered lines of a request: a map line's title apart from its place and description, or a
 * candidate's title apart from its place, heading and summary, and whether a plan's area found it.
 */
function linesOf(input: string): Line[] {
  return input.split('\n').flatMap((line) => {
    const m = /^(\d+)\. (.*)$/.exec(line);
    if (!m) return [];
    const [text, planned] = m[2].split(' | searched for: ');
    const [place, ...rest] = text.split(/ \(\d[\d,]* pages below\): | \| /);
    const parts = place.split(' › ');
    return [
      {
        number: Number(m[1]),
        title: parts.at(-1)!,
        rest: [...parts.slice(0, -1), ...rest].join(' '),
        summary: rest.at(-1) ?? '',
        planned: planned !== undefined,
        depth: parts.length,
      },
    ];
  });
}

/** What the stand-in was asked, by the request's label, so a test can count the requests. */
export type StandIn = { ai: Pick<AiEngine, 'analyzeDocument'>; asked: string[]; inputs: string[] };

/**
 * The stand-in model. `plan: false` makes it answer a planning request with a reply that cannot be
 * used, so a measurement can compare the same choosing with and without a plan.
 */
export function standInModel(options: { plan?: boolean } = {}): StandIn {
  const asked: string[] = [];
  const inputs: string[] = [];
  const analyzeDocument: AiEngine['analyzeDocument'] = (input, _prompt, label = '') => {
    asked.push(label);
    inputs.push(input);
    const question = words(/^Question: (.*)$/m.exec(input)?.[1] ?? '');
    const lines = linesOf(input).map((line) => ({
      line,
      title: words(line.title),
      all: words(`${line.title} ${line.rest}`),
    }));
    const holding = (w: string): number => lines.filter((l) => l.all.has(w)).length;
    const weight = new Map([...question].map((w) => [w, 1 / Math.max(1, holding(w))]));
    const scored = lines
      .map(({ line, title, all }) => {
        const found = shared(question, all);
        const sum = found.reduce((n, w) => n + weight.get(w)! * (title.has(w) ? 2 : 1), 0);
        return { line, score: (sum * (line.planned ? 1.5 : 1)) / Math.sqrt(all.size), found };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.line.depth - a.line.depth || a.line.number - b.line.number);
    const reply = (text: string): ReturnType<AiEngine['analyzeDocument']> =>
      Promise.resolve({ text, guard: { blocked: [], redacted: {}, summary: '' } });
    if (label.startsWith('Planning')) {
      if (options.plan === false) return reply('not a plan');
      const areas = scored
        .filter((s) => s.score >= scored[0].score / 2)
        .slice(0, 3)
        .map((s) => ({
          number: s.line.number,
          look: [...question].filter((w) => !s.found.includes(w)).join(' ') || [...question].join(' '),
          why: `it is about ${s.found.join(', ')}`,
        }));
      return reply(JSON.stringify({ areas }));
    }
    const said = new Set<string>();
    const sections = scored
      .filter((s) => !said.has(s.line.summary) && !!said.add(s.line.summary))
      .slice(0, 12)
      .map((s) => ({ number: s.line.number, why: s.found.join(', ') }));
    return reply(JSON.stringify({ sections }));
  };
  return { ai: { analyzeDocument }, asked, inputs };
}
