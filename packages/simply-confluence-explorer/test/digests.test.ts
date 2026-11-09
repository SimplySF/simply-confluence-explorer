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

// Directory digests (ADR-079): made from the children's titles, summaries and tags, never page text;
// lowest directories first; and not used once the allowed pages below a directory change.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MetadataProgress, PageDetail, SpaceMapResponse, SyncProgress } from '../src/api/types.js';
import type { AiEngine } from '../src/ai/engine.js';
import { DigestStore, digestEntries, packDigests } from '../src/spaces/digests.js';
import { ExclusionManager } from '../src/spaces/exclusionManager.js';
import { MetadataPipeline } from '../src/spaces/metadata.js';
import { SpaceStore } from '../src/spaces/spaceStore.js';
import { noTracer } from '../src/telemetry/tracer.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp, type TestApp } from './support/testApp.js';

const BODY_ONLY = 'BODY-ONLY-WORDS-7731';

const page = (id: string, title: string, parent?: PageDetail): PageDetail => ({
  id,
  title,
  spaceKey: 'PLAT',
  version: 1,
  author: 'admin',
  lastModified: '2026-06-01T00:00:00Z',
  storageXml: `<p>${BODY_ONLY} in ${title}.</p>`,
  labels: ['ops'],
  attachments: [],
  ...(parent ? { parentId: parent.id } : {}),
  ancestors: parent ? [...parent.ancestors, { id: parent.id, title: parent.title }] : [],
});

/**
 * Area › Runbooks › Deploy, Rollback; Area › Overview and four release notes. Every page already has
 * current metadata, so a run sends only digest requests.
 */
function space(): { store: SpaceStore; exclusions: ExclusionManager; digests: DigestStore; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-digest-'));
  const exclusions = new ExclusionManager(dataDir, () => undefined);
  const store = new SpaceStore(dataDir, exclusions, () => undefined);
  const area = page('1', 'Area');
  const runbooks = page('2', 'Runbooks', area);
  const pages = [
    area,
    runbooks,
    page('21', 'Deploy', runbooks),
    page('22', 'Rollback', runbooks),
    page('11', 'Overview', area),
    ...[0, 1, 2, 3].map((i) => page(`1${i + 2}`, `Release 1.${i} notes`, area)),
  ];
  for (const p of pages) {
    store.writePage('PLAT', p, '', []);
    store.writeMetadata('PLAT', meta(p.id, p.title));
  }
  return { store, exclusions, digests: new DigestStore(store, exclusions), dataDir };
}

const meta = (pageId: string, title: string, generatedAt = '2026-06-01T00:00:00Z') => ({
  pageId,
  title,
  summary: `Summary of ${title}.`,
  tags: [`tag-${title.toLowerCase().replace(/\W+/g, '-')}`],
  documentType: 'guide',
  systemsMentioned: [],
  generatedAt,
  version: 2,
});

/** A digest for every directory a request lists, naming every title its block quotes. */
function digestsFor(input: string): string {
  const blocks = input.split(/^=== DIRECTORY /m).slice(1);
  return JSON.stringify({
    directories: blocks.map((block) => {
      const [, n, title] = /^(\d+): (.*) ===/.exec(block)!;
      const named = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      return {
        number: Number(n),
        summary: `Digest of ${title}, covering ${named.join(', ')}.`,
        kind: 'living',
        topics: ['ops'],
        questions: [`What is in ${title}?`],
      };
    }),
  });
}

/** An AI that records what each request carries and answers with `reply`. */
function standIn(reply: (input: string, prompt: string) => string = digestsFor): {
  ai: AiEngine;
  inputs: string[];
  prompts: string[];
} {
  const inputs: string[] = [];
  const prompts: string[] = [];
  const ai: AiEngine = {
    isAvailable: () => true,
    getEngine: () => 'fake',
    analyzeDocument: (input, prompt) => {
      inputs.push(input);
      prompts.push(prompt);
      return Promise.resolve({ text: reply(input, prompt), guard: { redacted: {}, summary: '' } as never });
    },
    chat: () => Promise.reject(new Error('not used')),
  };
  return { ai, inputs, prompts };
}

async function run(s: ReturnType<typeof space>, ai: AiEngine, rootPageId?: string): Promise<MetadataProgress> {
  const pipeline = new MetadataPipeline(
    s.store,
    s.exclusions,
    () => ai,
    () => undefined,
    undefined,
    noTracer,
    {
      retryDelayMs: 0,
      digests: s.digests,
    },
  );
  const { jobId } = pipeline.start('PLAT', rootPageId);
  while (['pending', 'running'].includes(pipeline.get(jobId)?.status ?? '')) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each check before the next
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return pipeline.get(jobId)!;
}

describe('a directory digest request', () => {
  it("carries the children's titles, summaries and tags, and never a page's text", async () => {
    const s = space();
    const { ai, inputs } = standIn();
    const job = await run(s, ai);
    const sent = inputs.join('\n');
    expect(sent).toContain('"Deploy": Summary of Deploy. Tags: ops, tag-deploy.');
    expect(sent).toContain("The directory's own page: Summary of Runbooks.");
    expect(sent).not.toContain(BODY_ONLY);
    // The release notes are one line with their count, not four.
    expect(sent).toContain('A series of 4 pages titled like "release # notes"');
    expect(sent).not.toContain('Release 1.1 notes');
    expect(job).toMatchObject({ status: 'completed', errorCount: 0, directories: 2, directoriesDone: 2 });
  });

  it("is made for the lowest directories first, and a parent's carries its child directory's digest", async () => {
    const s = space();
    const { ai, inputs } = standIn();
    await run(s, ai);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatch(/^=== DIRECTORY 1: Runbooks ===/);
    expect(inputs[0]).not.toContain('DIRECTORY 2');
    expect(inputs[1]).toMatch(/^=== DIRECTORY 1: Area ===/);
    expect(inputs[1]).toContain('Directory "Runbooks" (2 pages below, living): Digest of Runbooks');
    expect(s.digests.currentDigest('PLAT', '1')).toMatchObject({ id: '1', title: 'Area', kind: 'living' });
  });

  it('caps a very long list of children, counting the rest', async () => {
    const s = space();
    const runbooks = s.store.readPage('PLAT', '2')!;
    for (let i = 0; i < 70; i++) {
      const title = `Step ${String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26))}`;
      s.store.writePage('PLAT', page(`9${i}`, title, runbooks), '', []);
      s.store.writeMetadata('PLAT', meta(`9${i}`, title));
    }
    const { ai, inputs } = standIn();
    await run(s, ai);
    expect(inputs[0]).toMatch(/- and 12 more$/m);
  });
});

describe('a digest whose pages changed', () => {
  it('is not current the moment an exclusion rule is added, and the excluded title reaches neither the next request nor digests.json', async () => {
    const s = space();
    await run(s, standIn().ai);
    const file = path.join(s.dataDir, 'spaces', 'PLAT', 'digests.json');
    expect(fs.readFileSync(file, 'utf8')).toContain('Rollback');
    expect(s.digests.currentDigest('PLAT', '2')).toBeDefined();
    // The rules file is saved without the store being told, as a person editing it by hand would.
    s.exclusions.savePatterns('PLAT', ['Rollback']);
    expect(s.digests.currentDigest('PLAT', '2')).toBeUndefined();
    expect(s.digests.currentDigest('PLAT', '1')).toBeUndefined();
    const { ai, inputs } = standIn();
    await run(s, ai);
    expect(inputs).toHaveLength(2);
    expect(inputs.join('\n')).not.toContain('Rollback');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('Rollback');
    expect(s.digests.currentDigest('PLAT', '2')).toBeDefined();
  });

  it('is skipped by a rerun while current, and made again, with the directories above it, once a page below is re-indexed', async () => {
    const s = space();
    await run(s, standIn().ai);
    const again = standIn();
    expect(await run(s, again.ai)).toMatchObject({ status: 'completed', directories: 0 });
    expect(again.inputs).toHaveLength(0);
    s.store.writeMetadata('PLAT', meta('21', 'Deploy', '2026-07-01T00:00:00Z'));
    expect(s.digests.currentDigest('PLAT', '2')).toBeUndefined();
    expect(s.digests.currentDigest('PLAT', '1')).toBeUndefined();
    const redo = standIn();
    await run(s, redo.ai);
    expect(redo.inputs.map((i) => /^=== DIRECTORY 1: (\w+)/.exec(i)?.[1])).toEqual(['Runbooks', 'Area']);
  });

  it('a run for a section digests only the directories in it', async () => {
    const s = space();
    const { ai, inputs } = standIn();
    await run(s, ai, '2');
    expect(inputs).toHaveLength(1);
    expect(s.digests.currentDigest('PLAT', '2')).toBeDefined();
    expect(s.digests.currentDigest('PLAT', '1')).toBeUndefined();
  });
});

describe('digest requests', () => {
  it('carry several directories each, up to a count and a size', () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      title: `D${i}`,
      stamp: 's',
      input: 'x'.repeat(100),
    }));
    expect(packDigests(tasks, 60_000).map((p) => p.length)).toEqual([12, 12, 6]);
    expect(packDigests(tasks, 250).map((p) => p.length)).toEqual(Array(15).fill(2));
  });

  it('ask once more when a reply is not usable, then record each directory as failed with why', async () => {
    const s = space();
    const bad = JSON.stringify({
      directories: [{ number: 1, summary: ' ', kind: 'living', topics: [], questions: [] }],
    });
    const { ai, prompts } = standIn(() => bad);
    const job = await run(s, ai, '2');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Your last reply could not be used: it gave directory 1 no summary.');
    expect(job.failures).toEqual([
      {
        pageId: '2',
        title: 'Runbooks, its directory digest',
        error: "the AI's reply was not what was asked for, twice (it gave directory 1 no summary)",
      },
    ]);
    expect(s.digests.currentDigest('PLAT', '2')).toBeUndefined();
  });

  it('hold a reply to its kinds and bounds', () => {
    const entry = { number: 1, summary: 'S', kind: 'living', topics: ['A', 'b'], questions: ['q'.repeat(400)] };
    expect(digestEntries({ directories: [{ ...entry, kind: 'archive' }] }, 1)).toMatch(/kind was not one of/);
    expect(digestEntries({ directories: [entry] }, 2)).toBe('it left out directory 2');
    expect(digestEntries({ directories: [{ ...entry, number: '1' }] }, 1)).toEqual([
      { summary: 'S', kind: 'living', topics: ['a', 'b'], questions: ['q'.repeat(300)] },
    ]);
  });
});

describe('the Space map route', () => {
  let fake: FakeConfluence;
  beforeAll(async () => {
    fake = await startFakeConfluence();
  });
  afterAll(() => fake.close());

  async function until<T extends { status: string; jobId: string }>(app: TestApp, route: string, first: T): Promise<T> {
    let progress = first;
    while (progress.status === 'pending' || progress.status === 'running') {
      // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
      await new Promise((resolve) => setTimeout(resolve, 20));
      // eslint-disable-next-line no-await-in-loop -- as above
      progress = (await app.call<T>('GET', `${route}/${first.jobId}`)).body;
    }
    return progress;
  }

  it('gives each directory the kind its current digest names, through the guarded engine', async () => {
    const app = await startTestApp(fake);
    try {
      const synced = (await app.call<SyncProgress>('POST', '/space-cache/sync', { spaceKey: 'PEOPLE' })).body;
      await until(app, '/space-cache/sync/status', synced);
      const before = (await app.call<SpaceMapResponse>('GET', '/space-cache/PEOPLE/map')).body;
      expect(before.directories.some((d) => d.kind)).toBe(false);
      const started = (await app.call<MetadataProgress>('POST', '/space-cache/PEOPLE/metadata/generate', {})).body;
      const done = await until(app, '/space-cache/metadata/status', started);
      expect(done).toMatchObject({ status: 'completed', errorCount: 0 });
      const after = (await app.call<SpaceMapResponse>('GET', '/space-cache/PEOPLE/map')).body;
      expect(after.directories.length).toBeGreaterThan(0);
      expect(after.directories.every((d) => d.kind === 'living')).toBe(true);
      expect(app.sentText()).toContain('=== DIRECTORY 1: ');
    } finally {
      await app.close();
    }
  });
});
