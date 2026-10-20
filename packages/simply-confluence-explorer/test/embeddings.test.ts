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

// Section embeddings: made only through the outbound guard, recorded in the audit log, reused until
// the page or the model changes, and never made by an engine that offers none (ADR-051).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PageDetail } from '../src/api/types.js';
import { ConfiguredAi } from '../src/ai/engine.js';
import type { GuardedPayload } from '../src/ai/guard.js';
import { AiSettingsStore } from '../src/ai/settings.js';
import { ExclusionManager } from '../src/spaces/exclusionManager.js';
import { MetadataPipeline } from '../src/spaces/metadata.js';
import { SpaceStore } from '../src/spaces/spaceStore.js';
import { cosine, decodeVector, encodeVector, VectorIndex } from '../src/spaces/vectors.js';
import { standInVector } from './support/standInEmbedder.js';

const j = (...parts: string[]): string => parts.join('');
const AWS_KEY = j('AKIA', 'IOSFODNN7', 'EXAMPLE');
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-embed-'));

/** An engine on the given environment whose embeddings are recorded instead of sent. */
function engine(
  env: NodeJS.ProcessEnv,
  withTransport = false,
): { ai: ConfiguredAi; sent: GuardedPayload[]; dataDir: string } {
  const dataDir = tmp();
  const sent: GuardedPayload[] = [];
  const ai = new ConfiguredAi(new AiSettingsStore(dataDir, env), {
    dataDir,
    env,
    log: () => undefined,
    ...(withTransport ? { transport: () => Promise.resolve('{}') } : {}),
    embedTransport: (payload) => {
      sent.push(payload);
      return Promise.resolve(payload.messages.map((m) => standInVector(m.content)));
    },
  });
  return { ai, sent, dataDir };
}

describe('embedding texts', () => {
  it('sends nothing with Claude or the Gemini CLI, which offer no embeddings', async () => {
    for (const env of [{ ANTHROPIC_API_KEY: 'k', AI_PROVIDER: 'anthropic' }, { AI_PROVIDER: 'gemini-cli' }]) {
      const { ai, sent } = engine(env);
      expect(ai.embeddingModel()).toBeNull();
      // eslint-disable-next-line no-await-in-loop -- each engine is checked in turn
      expect(await ai.embed(['Deploy steps.'], {})).toEqual([null]);
      expect(sent).toEqual([]);
    }
    expect(engine({ OPENAI_API_KEY: 'k', AI_PROVIDER: 'openai' }).ai.embeddingModel()).toBe('text-embedding-3-small');
    expect(engine({ GEMINI_API_KEY: 'k', AI_PROVIDER: 'gemini' }).ai.embeddingModel()).toBe('gemini-embedding-001');
    // A test that replaces the AI without replacing its embeddings must not reach a real provider.
    const stubbed = new ConfiguredAi(new AiSettingsStore(tmp(), { OPENAI_API_KEY: 'k', AI_PROVIDER: 'openai' }), {
      dataDir: tmp(),
      env: {},
      log: () => undefined,
      transport: () => Promise.resolve(''),
    });
    expect(stubbed.embeddingModel()).toBeNull();
  });

  it('leaves out a text holding a secret, replaces personal data, and records the request', async () => {
    const { ai, sent, dataDir } = engine({ OPENAI_API_KEY: 'k', AI_PROVIDER: 'openai' });
    const vectors = await ai.embed(['Ask jane.doe@example.com.', `The key is ${AWS_KEY}.`, 'Deploy.'], {});
    expect(vectors.map((v) => v !== null)).toEqual([true, false, true]);
    const text = sent.flatMap((p) => p.messages.map((m) => m.content)).join('\n');
    expect(text).toContain('Ask [EMAIL-1].');
    expect(text).not.toContain(AWS_KEY);
    expect(text).not.toContain('jane.doe');
    const audit = fs
      .readFileSync(path.join(dataDir, 'data', 'ai-audit.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(JSON.parse(audit[0])).toMatchObject({
      texts: 2,
      withheld: 1,
      outcome: 'sent',
      redacted: { 'email address': 1 },
    });
    expect(audit.join('\n')).not.toContain('Deploy');
  });

  it('keeps vectors exactly through their encoding, and compares them by direction', () => {
    expect([...decodeVector(encodeVector([0.5, -1, 2]))]).toEqual([0.5, -1, 2]);
    expect(cosine([1, 0], [2, 0])).toBe(1);
    expect(cosine([1, 0], [0, 3])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });
});

const page = (version: number): PageDetail => ({
  id: '1',
  title: 'Runbook',
  spaceKey: 'PLAT',
  version,
  author: 'admin',
  lastModified: '2026-01-01T00:00:00Z',
  storageXml: '<h1>Deploy</h1><p>Ship it.</p><h1>Rollback</h1><p>Undo it.</p>',
  labels: [],
  attachments: [],
  ancestors: [],
});

describe('the index job', () => {
  it('embeds each section once, and again only when the page or the model changes', async () => {
    const dataDir = tmp();
    const log = (): void => undefined;
    const exclusions = new ExclusionManager(dataDir, log);
    const store = new SpaceStore(dataDir, exclusions, log);
    const vectors = new VectorIndex(store);
    store.writePage('PLAT', page(1), '', []);
    let model = 'model-a';
    const embedded: string[][] = [];
    const ai = {
      isAvailable: () => true,
      getEngine: () => 'fake',
      analyzeDocument: () => Promise.resolve({ text: '{"summary":"S","tags":[]}', guard: {} as never }),
      chat: () => Promise.reject(new Error('not used')),
      embeddingModel: () => model,
      embed: (texts: string[]) => {
        embedded.push(texts);
        return Promise.resolve(texts.map(standInVector));
      },
    };
    const pipeline = new MetadataPipeline(store, exclusions, () => ai, log, vectors);
    const run = async (): Promise<void> => {
      const { jobId } = pipeline.start('PLAT');
      while (['pending', 'running'].includes(pipeline.get(jobId)?.status ?? '')) {
        // eslint-disable-next-line no-await-in-loop -- polling waits for each check before the next
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await run();
    expect(embedded).toEqual([['Runbook › Deploy\n\nShip it.', 'Runbook › Rollback\n\nUndo it.']]);
    expect(pipeline.coverage('PLAT')).toEqual({ pages: 1, missing: 0 });
    await run();
    expect(embedded).toHaveLength(1);
    model = 'model-b';
    expect(pipeline.coverage('PLAT').missing).toBe(1);
    await run();
    expect(embedded).toHaveLength(2);
    store.refreshPage('PLAT', page(2));
    expect(store.readVectors('PLAT', '1')).toBeUndefined();
    // The reloaded index reads the files, not what this one remembers.
    expect(new VectorIndex(store).has(page(2), model)).toBe(false);
    await run();
    expect(embedded).toHaveLength(3);
    expect(new VectorIndex(store).has(page(2), model)).toBe(true);
    // Metadata of an older kind is redone without embedding the unchanged page again.
    store.writeMetadata('PLAT', { ...store.readMetadata('PLAT', '1')!, version: undefined });
    await run();
    expect(store.readMetadata('PLAT', '1')?.version).toBe(2);
    expect(embedded).toHaveLength(3);
  });
});
