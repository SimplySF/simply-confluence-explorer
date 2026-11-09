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

// Indexing several pages per request, a few requests at once, with every page accounted for
// (ADR-054, design doc 0008).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PageDetail } from '../src/api/types.js';
import type { AiEngine } from '../src/ai/engine.js';
import { ExclusionManager } from '../src/spaces/exclusionManager.js';
import { generateMetadataPack, packPages, PACK_CHARS, withRetry } from '../src/spaces/indexPacks.js';
import { MetadataPipeline } from '../src/spaces/metadata.js';
import { SpaceStore } from '../src/spaces/spaceStore.js';
import { packedPages } from './support/testApp.js';

const page = (id: string, size = 100): PageDetail => ({
  id,
  title: `Page ${id}`,
  spaceKey: 'PLAT',
  version: 1,
  author: 'a',
  lastModified: '2026-01-01',
  storageXml: `<p>${'x'.repeat(Math.max(0, size - 7))}</p>`,
  labels: [],
  attachments: [],
  ancestors: [],
});

/** An AI that answers a pack with an entry for each page it lists, except those in `skip`. */
function packAi(skip: string[] = [], delayMs = 0): { ai: AiEngine; requests: string[][]; most: () => number } {
  const requests: string[][] = [];
  let busy = 0;
  let most = 0;
  const ai: AiEngine = {
    isAvailable: () => true,
    getEngine: () => 'fake',
    parallel: () => 3,
    analyzeDocument: async (markdown) => {
      busy++;
      most = Math.max(most, busy);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      busy--;
      const pages = packedPages(markdown);
      requests.push(pages.map((p) => p.id));
      const entry = { summary: 'S', tags: ['ops'] };
      return {
        text: JSON.stringify(
          pages.length ? { pages: pages.filter((p) => !skip.includes(p.id)).map((p) => ({ ...p, ...entry })) } : entry,
        ),
        guard: {} as never,
      };
    },
    chat: () => Promise.reject(new Error('not used')),
  };
  return { ai, requests, most: () => most };
}

describe('packing pages', () => {
  it('puts small pages together up to the limit, a large page alone, in the order given', () => {
    const packs = packPages([page('1'), page('2'), page('big', PACK_CHARS + 10), page('3'), page('4')]);
    expect(packs.map((p) => p.map((x) => x.id))).toEqual([['1', '2'], ['big'], ['3', '4']]);
  });
});

describe('a pack reply', () => {
  it('accounts for every page sent: one left out of the reply is reported as such', async () => {
    const { ai } = packAi(['2']);
    const results = await generateMetadataPack([page('1'), page('2')], ai, []);
    expect(results.get('1')).toMatchObject({ pageId: '1', summary: 'S', version: 2 });
    expect(results.get('2')).toEqual(new Error('the AI reply left this page out'));
  });

  it('reports every page when the reply cannot be read', async () => {
    const ai = { ...packAi().ai, analyzeDocument: () => Promise.resolve({ text: '{ not json', guard: {} as never }) };
    const results = await generateMetadataPack([page('1'), page('2')], ai, []);
    expect(
      [...results.values()].every((r) => r instanceof Error && r.message.startsWith('the AI reply could not be read')),
    ).toBe(true);
  });
});

describe('the quality of a pack reply', () => {
  const sections = (id: string): PageDetail => ({
    ...page(id),
    storageXml:
      '<h1>One</h1><p>a</p><h1>Two</h1><p>b</p><h1>Three</h1><p>c</p><h1>Four</h1><p>d</p><h1>Five</h1><p>e</p>',
  });
  /** An AI that answers a pack with the entry `entryOf` gives each page, a line for every section unless it says otherwise. */
  const replying = (entryOf: (id: string) => Record<string, unknown>): AiEngine => ({
    ...packAi().ai,
    analyzeDocument: (markdown) =>
      Promise.resolve({
        text: JSON.stringify({
          pages: packedPages(markdown).map((p) => ({ ...p, summary: 'S', tags: [], ...entryOf(p.id) })),
        }),
        guard: {} as never,
      }),
  });

  it('keeps no page whose summary is empty or the default, or that describes under four in five of its sections', async () => {
    const thin = { '2': { summary: '' }, '3': { summary: 'Documentation page.' }, '4': { sections: ['a', 'b', 'c'] } };
    const ai = replying((id) => thin[id as keyof typeof thin] ?? {});
    const results = await generateMetadataPack(['1', '2', '3', '4', '5'].map(sections), ai, []);
    expect(results.get('1')).toMatchObject({ summary: 'S' });
    expect(results.get('2')).toEqual(new Error('the AI reply gave the page no summary'));
    expect(results.get('3')).toEqual(new Error('the AI reply gave the page no summary'));
    expect(results.get('4')).toEqual(new Error("the AI reply described 3 of the page's 5 sections"));
    // Four lines of five is enough.
    expect(
      (
        await generateMetadataPack(
          [sections('5')],
          replying(() => ({ sections: ['a', 'b', 'c', 'd'] })),
          [],
        )
      ).get('5'),
    ).toMatchObject({ summary: 'S' });
  });

  it('asks again on its own for a page described too thinly, and records it as failed with why when that fails too', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-packs-'));
    const exclusions = new ExclusionManager(dataDir, () => undefined);
    const store = new SpaceStore(dataDir, exclusions, () => undefined);
    for (const id of ['1', '2', '3']) store.writePage('PLAT', sections(id), '', []);
    const alone: string[] = [];
    const ai: AiEngine = {
      ...packAi().ai,
      analyzeDocument: (markdown, _prompt, title) => {
        const pages = packedPages(markdown);
        if (!pages.length) alone.push(title ?? '');
        const entry = (id: string): Record<string, unknown> => ({
          summary: id === '2' ? '' : 'S',
          tags: [],
          sections: id === '3' ? ['a'] : ['a', 'b', 'c', 'd', 'e'],
        });
        return Promise.resolve({
          // The pack leaves page 1 out. Alone, page 3 is accepted with the lines it has; page 2 still has no summary.
          text: JSON.stringify(
            pages.length
              ? { pages: pages.filter((p) => p.id !== '1').map((p) => ({ id: p.id, ...entry(p.id) })) }
              : entry(/Page (\d)/.exec(title ?? '')![1]),
          ),
          guard: {} as never,
        });
      },
    };
    const pipeline = new MetadataPipeline(
      store,
      exclusions,
      () => ai,
      () => undefined,
      undefined,
      undefined,
      {
        retryDelayMs: 0,
      },
    );
    const { jobId } = pipeline.start('PLAT');
    while (['pending', 'running'].includes(pipeline.get(jobId)?.status ?? '')) {
      // eslint-disable-next-line no-await-in-loop -- polling waits for each check before the next
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const job = pipeline.get(jobId)!;
    // Page 1 had no entry, page 2 no summary and page 3 one line of five: each was asked for alone,
    // page 2 twice (the repair), and never a third time.
    expect(alone.sort()).toEqual(['Page 1', 'Page 2', 'Page 2', 'Page 3']);
    expect(job.failures).toEqual([
      {
        pageId: '2',
        title: 'Page 2',
        error: "the AI's reply was not what was asked for, twice (it gave the page no summary)",
      },
    ]);
    expect(store.readMetadata('PLAT', '3')?.sections?.map((s) => s.summary)).toEqual(['a', '', '', '', '']);
  });
});

describe('an index run', () => {
  it('sends a few packs at once, asks again on its own for a page a pack left out, and indexes every page', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-packs-'));
    const exclusions = new ExclusionManager(dataDir, () => undefined);
    const store = new SpaceStore(dataDir, exclusions, () => undefined);
    // Pages large enough that eight fit nowhere together: four packs of two.
    for (let i = 1; i <= 8; i++) store.writePage('PLAT', page(String(i), PACK_CHARS / 2 - 100), '', []);
    const { ai, requests, most } = packAi(['5'], 20);
    const pipeline = new MetadataPipeline(
      store,
      exclusions,
      () => ai,
      () => undefined,
      undefined,
      undefined,
      { retryDelayMs: 0 },
    );
    const { jobId } = pipeline.start('PLAT');
    while (['pending', 'running'].includes(pipeline.get(jobId)?.status ?? '')) {
      // eslint-disable-next-line no-await-in-loop -- polling waits for each check before the next
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const job = pipeline.get(jobId)!;
    expect([job.requests, job.requestsDone, job.processed, job.errorCount]).toEqual([4, 4, 8, 0]);
    expect(most()).toBe(3);
    // The page left out of its pack was asked for alone, as a request that lists no pack.
    expect(requests.filter((r) => r.length === 0)).toHaveLength(1);
    for (let i = 1; i <= 8; i++) expect(store.readMetadata('PLAT', String(i))?.summary).toBe('S');
  });
});

describe('trying again', () => {
  it('tries a failed request twice more, then gives up with the last error', async () => {
    let tries = 0;
    const failing = (): Promise<never> => {
      tries++;
      return Promise.reject(new Error('429 Too Many Requests'));
    };
    await expect(withRetry(failing, 0, () => false)).rejects.toThrow('429');
    expect(tries).toBe(3);
  });

  it('stops trying once the run is stopped', async () => {
    let tries = 0;
    await expect(
      withRetry(
        () => {
          tries++;
          return Promise.reject(new Error('timeout'));
        },
        0,
        () => true,
      ),
    ).rejects.toThrow('timeout');
    expect(tries).toBe(1);
  });
});
