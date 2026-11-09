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

// A large corpus is searched so that no single directory or series fills the candidates, and by a
// plan over a map of its directories (ADR-079, design doc 0017).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiEngine } from '../src/ai/engine.js';
import { ManifestBuilder, summarise } from '../src/ai/manifest.js';
import type { PageDetail } from '../src/api/types.js';
import { diversify, retrieveContext, sectionBatches } from '../src/spaces/contextRetriever.js';
import { ExclusionManager } from '../src/spaces/exclusionManager.js';
import { SearchIndex } from '../src/spaces/searchIndex.js';
import { SpaceStore } from '../src/spaces/spaceStore.js';

describe('the diversity cap', () => {
  const group = (id: string): string[] => [`dir:${id.split('-')[0]}`];

  it('lets no directory take more than 8 of 40 candidates when others matched', () => {
    const notes = Array.from({ length: 100 }, (_, i) => `notes-${i}`);
    const others = Array.from({ length: 4 }, (_, i) => [`identity-${i}`, `payments-${i}`, `people-${i}`]).flat();
    const ranked = diversify([[...notes, ...others]], 40, group);
    expect(ranked).toEqual([...notes.slice(0, 8), ...others]);
  });

  it('still offers a full list from a corpus of one directory', () => {
    const notes = Array.from({ length: 100 }, (_, i) => `notes-${i}`);
    expect(diversify([notes], 40, group)).toEqual(notes.slice(0, 40));
  });

  it('takes from each ranking in turn, so every ranking contributes', () => {
    const a = Array.from({ length: 5 }, (_, i) => `a${i}-x`);
    const b = Array.from({ length: 5 }, (_, i) => `b${i}-x`);
    expect(diversify([a, ['c-1'], b], 6, (id) => [id])).toEqual(['a0-x', 'c-1', 'b0-x', 'a1-x', 'b1-x', 'a2-x']);
  });
});

type Node = { title: string; text: string; children?: Node[] };

/**
 * A small space of three areas, each a directory with pages below it, and an area its rules exclude.
 * Every page has a summary, so the AI is asked to choose among the candidates.
 */
const SPACE: Node[] = [
  {
    title: 'Payments',
    text: 'How money moves.',
    children: [
      {
        title: 'Refunds',
        text: 'Money going back.',
        children: [{ title: 'Card returns', text: 'A return reaches the card within five days.' }],
      },
      { title: 'Payouts', text: 'Merchants are paid on Tuesdays.' },
    ],
  },
  {
    title: 'Secret project',
    text: 'Not to be shared.',
    children: [{ title: 'Codename plans', text: 'The codename launches in spring.' }],
  },
  {
    title: 'Release notes',
    text: 'Every release.',
    children: Array.from({ length: 30 }, (_, n) => ({
      title: `Release ${n} notes`,
      text: `Fixed: a refund to a card was shown twice in release ${n}.`,
    })),
  },
];

let dirs: string[] = [];
afterEach(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

async function space(): Promise<{
  store: SpaceStore;
  exclusions: ExclusionManager;
  index: SearchIndex;
  dataDir: string;
  all: PageDetail[];
}> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-plan-'));
  dirs = [...dirs, dataDir];
  const exclusions = new ExclusionManager(dataDir, () => undefined);
  const store = new SpaceStore(dataDir, exclusions, () => undefined);
  let next = 0;
  const write = (node: Node, ancestors: Array<{ id: string; title: string }>): void => {
    const id = String(++next);
    const page: PageDetail = {
      id,
      title: node.title,
      spaceKey: 'PLAN',
      parentId: ancestors.at(-1)?.id,
      version: 1,
      author: 'a',
      lastModified: '2026-01-01',
      storageXml: `<h2>About</h2><p>${node.text}</p><h2>More</h2><p>${node.text} ${'More words. '.repeat(20)}</p>`,
      labels: [],
      attachments: [],
      ancestors,
    };
    store.writePage('PLAN', page, '', []);
    store.writeMetadata('PLAN', {
      pageId: id,
      title: node.title,
      summary: node.text,
      tags: [],
      documentType: 'reference',
      systemsMentioned: [],
      generatedAt: '2026-01-02',
      version: 2,
    });
    for (const child of node.children ?? []) write(child, [...ancestors, { id, title: node.title }]);
  };
  SPACE.forEach((n) => write(n, []));
  store.writeManifest('PLAN', { spaceKey: 'PLAN', name: 'Plan', lastSynced: '2026-01-01', pageCount: next });
  fs.writeFileSync(path.join(dataDir, 'spaces', 'PLAN', '.confluenceignore'), 'Secret project/\n');
  const index = new SearchIndex(store);
  await index.ready('PLAN');
  const all = Array.from({ length: next }, (_, i) => store.readPage('PLAN', String(i + 1))!);
  return { store, exclusions, index, dataDir, all };
}

/** An AI that answers a plan with `plan` and a choice with the first candidate, recording what it was sent. */
function recordingAi(plan: string): {
  ai: Pick<AiEngine, 'analyzeDocument'>;
  sent: Array<{ label: string; input: string }>;
} {
  const sent: Array<{ label: string; input: string }> = [];
  return {
    sent,
    ai: {
      analyzeDocument: (input, _prompt, label = '') => {
        sent.push({ label, input });
        const text = label.startsWith('Planning') ? plan : '{"sections":[{"number":1,"why":"first"}]}';
        return Promise.resolve({ text, guard: { blocked: [], redacted: {}, summary: '' } });
      },
    },
  };
}

const PAYMENTS_PLAN = '{"areas":[{"number":1,"look":"card return","why":"refunds are payments"}]}';

describe('a planned search', () => {
  it('never names an excluded directory in the planning request, even when the corpus holds its pages', async () => {
    const deps = await space();
    const { ai, sent } = recordingAi(PAYMENTS_PLAN);
    const manifest = new ManifestBuilder();
    await retrieveContext(
      'PLAN',
      deps.all,
      { question: 'refunds to a card' },
      { ...deps, ai },
      { budget: 1_500, manifest, outline: true },
    );
    const planning = sent.filter((s) => s.label.startsWith('Planning'));
    expect(planning).toHaveLength(1);
    expect(planning[0].input).toContain('Payments');
    expect(sent.map((s) => s.input).join('\n')).not.toMatch(/Secret project|Codename/);
    expect(JSON.stringify(summarise(manifest.build()))).not.toMatch(/Secret project|Codename/);
  });

  it('searches the chosen area, records it with why, and counts the areas it left out', async () => {
    const deps = await space();
    const visible = await deps.store.visiblePages('PLAN');
    const { ai, sent } = recordingAi(PAYMENTS_PLAN);
    const steps: string[] = [];
    const manifest = new ManifestBuilder();
    const r = await retrieveContext(
      'PLAN',
      visible,
      { question: 'refunds to a card' },
      { ...deps, ai, onStep: (s) => steps.push(s) },
      { budget: 1_500, manifest },
    );
    expect(steps.slice(0, 2)).toEqual(['Planning which areas to search', 'Searching 1 area']);
    const choosing = sent.find((s) => s.label.startsWith('Choosing'))!.input;
    expect(choosing).toContain('Card returns');
    expect(choosing).toContain('searched for: card return');
    expect(r.selectedPages.length).toBeGreaterThan(0);
    expect(summarise(manifest.build()).plan).toEqual({
      searched: [{ title: 'Payments', look: 'card return', why: 'refunds are payments' }],
      notSearched: { count: 1, titles: ['Release notes'] },
    });
  });

  it('describes a directory by its digest when the whole directory is in the corpus', async () => {
    const deps = await space();
    const visible = await deps.store.visiblePages('PLAN');
    const { ai, sent } = recordingAi(PAYMENTS_PLAN);
    const digest = (_key: string, id: string) =>
      id === '1'
        ? {
            id,
            title: 'Payments',
            summary: 'Where refunds and payouts are run.',
            kind: 'living' as const,
            topics: ['money'],
            questions: [],
            stamp: 's',
            generatedAt: '',
          }
        : undefined;
    await retrieveContext('PLAN', visible, { question: 'refunds' }, { ...deps, ai, digest }, { budget: 1_500 });
    expect(sent[0].input).toContain('Payments (3 pages below): living: Where refunds and payouts are run. (money)');
  });

  it('searches the whole corpus at once, and says so, when the plan cannot be read twice', async () => {
    const deps = await space();
    const visible = await deps.store.visiblePages('PLAN');
    const { ai, sent } = recordingAi('no plan here');
    const manifest = new ManifestBuilder();
    const r = await retrieveContext(
      'PLAN',
      visible,
      { question: 'refunds to a card' },
      { ...deps, ai },
      { budget: 1_500, manifest },
    );
    expect(sent.filter((s) => s.label.startsWith('Planning'))).toHaveLength(2);
    expect(r.selectedPages.length).toBeGreaterThan(0);
    const summary = summarise(manifest.build());
    expect(summary.plan).toBeUndefined();
    expect(summary.leftOut).toContainEqual(
      expect.objectContaining({ reason: 'fallback', why: expect.stringMatching(/whole corpus was searched at once/) }),
    );
  });

  it('shows a map too large for one request from the top first, then below the areas chosen', async () => {
    const deps = await space();
    const visible = await deps.store.visiblePages('PLAN');
    const { ai, sent } = recordingAi(PAYMENTS_PLAN);
    const manifest = new ManifestBuilder();
    // A quarter of this budget holds only the first line of the map.
    await retrieveContext(
      'PLAN',
      visible,
      { question: 'refunds to a card' },
      { ...deps, ai },
      { budget: 400, manifest },
    );
    const planning = sent.filter((s) => s.label.startsWith('Planning')).map((s) => s.input);
    expect(planning.length).toBeGreaterThan(1);
    expect(planning[0]).not.toContain('Refunds (1 pages below)');
    expect(planning[1]).toContain('Payments › Refunds');
  });

  it('is not asked for when the corpus fits in one request', async () => {
    const deps = await space();
    const visible = await deps.store.visiblePages('PLAN');
    const { ai, sent } = recordingAi(PAYMENTS_PLAN);
    const r = await retrieveContext('PLAN', visible, { question: 'refunds' }, { ...deps, ai }, { budget: 200_000 });
    expect(r.corpus.mode).toBe('full');
    expect(sent).toHaveLength(0);
  });

  it('spreads a thorough answer across the planned areas, and records the plan', async () => {
    const deps = await space();
    const visible = await deps.store.visiblePages('PLAN');
    const { ai } = recordingAi(PAYMENTS_PLAN);
    const batches = await sectionBatches('PLAN', visible, { question: 'refunds to a card' }, { ...deps, ai }, 1_500);
    expect(batches.batches.flat().some((id) => id.startsWith('3#'))).toBe(true);
    expect(batches.planned.plan?.searched.map((a) => a.title)).toEqual(['Payments']);
  });
});
