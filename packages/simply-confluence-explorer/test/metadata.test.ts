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

// Metadata of the second kind: section summaries, questions, and topics shared across a space (ADR-051).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PageDetail, PageMetadata } from '../src/api/types.js';
import type { AiEngine } from '../src/ai/engine.js';
import { ExclusionManager } from '../src/spaces/exclusionManager.js';
import { generateMetadata, MetadataPipeline } from '../src/spaces/metadata.js';
import { SpaceStore } from '../src/spaces/spaceStore.js';
import { noTracer } from '../src/telemetry/tracer.js';

const page = (id: string, title: string, storageXml: string): PageDetail => ({
  id,
  title,
  spaceKey: 'PLAT',
  version: 1,
  author: 'admin',
  lastModified: '2026-01-01T00:00:00Z',
  storageXml,
  labels: [],
  attachments: [],
  ancestors: [],
});

/** An AI that records each prompt and answers with the given reply. */
function fakeAi(reply: (prompt: string) => string): { ai: AiEngine; prompts: string[] } {
  const prompts: string[] = [];
  const ai: AiEngine = {
    isAvailable: () => true,
    getEngine: () => 'fake',
    analyzeDocument: (_markdown, prompt) => {
      prompts.push(prompt);
      return Promise.resolve({ text: reply(prompt), guard: { redacted: {}, summary: '' } as never });
    },
    chat: () => Promise.reject(new Error('not used')),
  };
  return { ai, prompts };
}

function setup(): { store: SpaceStore; exclusions: ExclusionManager } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-meta-'));
  const log = (): void => undefined;
  const exclusions = new ExclusionManager(dataDir, log);
  return { store: new SpaceStore(dataDir, exclusions, log), exclusions };
}

const meta = (pageId: string, extra: Partial<PageMetadata> = {}): PageMetadata => ({
  pageId,
  title: pageId,
  summary: 'Old.',
  tags: ['devops'],
  documentType: 'guide',
  systemsMentioned: [],
  generatedAt: '2026-01-01T00:00:00Z',
  ...extra,
});

async function finish(pipeline: MetadataPipeline, jobId: string): Promise<void> {
  while (['pending', 'running'].includes(pipeline.get(jobId)?.status ?? '')) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each check before the next
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('metadata of the second kind', () => {
  it('matches each section line to its section by position, leaving a skipped one empty', async () => {
    const { ai, prompts } = fakeAi(() => '{"summary":"S","tags":["CI"],"sections":["Shipping."],"questions":["How?"]}');
    const result = await generateMetadata(
      page('1', 'Runbook', '<h1>Deploy</h1><p>Ship.</p><h1>Rollback</h1><p>Revert.</p>'),
      ai,
    );
    expect(prompts[0]).toContain('1. Runbook › Deploy\n2. Runbook › Rollback');
    expect(result.sections).toEqual([
      { heading: 'Runbook › Deploy', summary: 'Shipping.' },
      { heading: 'Runbook › Rollback', summary: '' },
    ]);
    expect([result.version, result.tags, result.questions]).toEqual([2, ['ci'], ['How?']]);
  });

  it('redoes metadata of the first kind, and leaves current metadata alone', async () => {
    const { store, exclusions } = setup();
    for (const id of ['1', '2']) store.writePage('PLAT', page(id, `Page ${id}`, '<p>Text.</p>'), '', []);
    store.writeMetadata('PLAT', meta('1'));
    store.writeMetadata('PLAT', meta('2', { version: 2 }));
    store.writeManifest('PLAT', {
      spaceKey: 'PLAT',
      name: 'Platform',
      lastSynced: '2026-01-01T00:00:00Z',
      pageCount: 2,
    });
    expect(store.listSynced()[0].metadataCount).toBe(1);
    const { ai, prompts } = fakeAi(() => '{"summary":"New.","tags":[]}');
    const pipeline = new MetadataPipeline(
      store,
      exclusions,
      () => ai,
      () => undefined,
    );
    expect(pipeline.coverage('PLAT')).toEqual({ pages: 2, missing: 1 });
    await finish(pipeline, pipeline.start('PLAT').jobId);
    expect(prompts).toHaveLength(1);
    expect(store.readMetadata('PLAT', '1')?.summary).toBe('New.');
    expect(pipeline.coverage('PLAT')).toEqual({ pages: 2, missing: 0 });
  });

  it("offers the space's topics, including those given earlier in the same run", async () => {
    const { store, exclusions } = setup();
    for (const id of ['1', '2', '3']) store.writePage('PLAT', page(id, `Page ${id}`, '<p>Text.</p>'), '', []);
    store.writeMetadata('PLAT', meta('1', { version: 2, tags: ['source-control'] }));
    const { ai, prompts } = fakeAi(() => '{"summary":"New.","tags":["Pipelines"]}');
    const pipeline = new MetadataPipeline(
      store,
      exclusions,
      () => ai,
      () => undefined,
    );
    await finish(pipeline, pipeline.start('PLAT').jobId);
    expect(prompts[0]).toContain('add a new one only for a subject none of them covers: source-control.');
    expect(prompts[1]).toContain(': source-control, pipelines.');
  });
});

describe('an index run with failures', () => {
  it('records each page left out with its reason, and raises a problem, where it was only counted before', async () => {
    const { store, exclusions } = setup();
    for (const id of ['1', '2']) store.writePage('PLAT', page(id, `Page ${id}`, '<p>Text.</p>'), '', []);
    const { ai } = fakeAi((prompt) => {
      if (prompt.includes('Page 2')) throw new Error('quota exceeded');
      return '{"summary":"S","tags":[]}';
    });
    const problems: string[] = [];
    const tracer = { ...noTracer, problem: (_kind: string, message: string) => void problems.push(message) };
    const pipeline = new MetadataPipeline(
      store,
      exclusions,
      () => ai,
      () => undefined,
      undefined,
      tracer,
    );
    const { jobId } = pipeline.start('PLAT');
    await finish(pipeline, jobId);
    expect(pipeline.get(jobId)?.failures).toEqual([{ pageId: '2', title: 'Page 2', error: 'quota exceeded' }]);
    expect(problems).toEqual(['The AI index of PLAT left out 1 page.']);
  });
});
