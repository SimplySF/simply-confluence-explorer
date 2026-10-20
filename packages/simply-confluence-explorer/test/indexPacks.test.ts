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
      const ids = [...markdown.matchAll(/^=== PAGE (\S+): /gm)].map((m) => m[1]);
      requests.push(ids);
      const entry = { summary: 'S', tags: ['ops'] };
      return {
        text: JSON.stringify(
          ids.length ? { pages: ids.filter((id) => !skip.includes(id)).map((id) => ({ id, ...entry })) } : entry,
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
