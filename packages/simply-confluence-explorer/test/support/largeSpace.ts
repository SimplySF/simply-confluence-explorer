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

// A generated space the size of the one the app is built for, about 3,200 pages, served by the app
// with a stand-in AI, and the walk a person takes through it: the search index built, the AI index
// run, and a question asked (design doc 0008). The fast suite checks what the walk produces; the scale
// check times the server while it runs.

import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AiSessionView } from '../../src/api/types.js';
import { createServer } from '../../src/server.js';
import { ExclusionManager } from '../../src/spaces/exclusionManager.js';
import { SpaceStore } from '../../src/spaces/spaceStore.js';
import { metadataReply } from './testApp.js';

export const PAGES = 3200;
const WORDS =
  'deploy rollback database failover gateway billing auth kafka postgres runbook incident pager vpn access'.split(' ');

function generatedSpace(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-big-'));
  const store = new SpaceStore(dataDir, new ExclusionManager(dataDir, () => undefined), () => undefined);
  const para = (seed: number): string =>
    Array.from({ length: 50 }, (_, i) => WORDS[(seed * 7 + i * 13) % WORDS.length]).join(' ');
  for (let i = 1; i <= PAGES; i++) {
    const parent = i <= 40 ? undefined : String((i % 40) + 1);
    const body = Array.from({ length: 5 }, (_, s) => `<h2>Part ${s}</h2><p>${para(i + s)}</p>`).join('');
    store.writePage(
      'BIG',
      {
        id: String(i),
        title: `Page ${i}`,
        spaceKey: 'BIG',
        parentId: parent,
        version: 1,
        author: 'a',
        lastModified: '2026-01-01',
        storageXml: body,
        labels: [],
        attachments: [],
        ancestors: parent ? [{ id: parent, title: `Page ${parent}` }] : [],
      },
      '',
      [],
    );
  }
  store.writeManifest('BIG', { spaceKey: 'BIG', name: 'Big', lastSynced: '2026-01-01', pageCount: PAGES });
  return dataDir;
}

export type LargeSpace = {
  base: string;
  /** How many requests the AI index has sent. */
  indexRequests: () => number;
  close: () => Promise<void>;
};

export async function startLargeSpace(): Promise<LargeSpace> {
  const dataDir = generatedSpace();
  let indexRequests = 0;
  const server: http.Server = createServer({
    webRoot: dataDir,
    dataDir,
    env: {
      CONFLUENCE_URL: 'http://127.0.0.1:9',
      CONFLUENCE_PERSONAL_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'k',
      AI_PROVIDER: 'anthropic',
    },
    aiTransport: (payload) => {
      if (!payload.system.includes('return a JSON object')) return Promise.resolve('an answer');
      indexRequests++;
      return Promise.resolve(metadataReply(payload, { summary: 'A page about operations.', tags: ['ops'] }));
    },
    telemetryTimers: false,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
    indexRequests: () => indexRequests,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export type Walk = {
  /** How the AI index run ended, and how many pages it left unindexed. */
  status: string;
  missing: number;
  answered: AiSessionView;
};

/**
 * Builds the search index, runs the AI index over every page, and asks a question about the whole
 * space, as a person would. `onStep` is told as each part starts.
 */
export async function walk(space: LargeSpace, onStep: (step: string) => void = () => undefined): Promise<Walk> {
  const post = async <T>(route: string, body: unknown): Promise<T> =>
    (
      await fetch(space.base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json() as Promise<T>;
  onStep('search index');
  let coverage: { indexing?: unknown; missing?: number } = await post('/space-cache/BIG/metadata/coverage', {});
  while (coverage.indexing) {
    // eslint-disable-next-line no-await-in-loop -- asks again until the index is built, as the chat does
    coverage = await post('/space-cache/BIG/metadata/coverage', {});
  }
  onStep('AI index');
  const run = await post<{ jobId: string }>('/space-cache/BIG/metadata/generate', {});
  let status = 'running';
  while (status === 'running' || status === 'pending') {
    // eslint-disable-next-line no-await-in-loop -- polls until the run ends, as the header does
    await new Promise((resolve) => setTimeout(resolve, 50));
    // eslint-disable-next-line no-await-in-loop -- as above
    const response = await fetch(`${space.base}/space-cache/metadata/status/${run.jobId}`);
    // eslint-disable-next-line no-await-in-loop -- as above
    status = ((await response.json()) as { status: string }).status;
  }
  onStep('after the AI index');
  const after = await post<{ missing: number }>('/space-cache/BIG/metadata/coverage', {});
  onStep('question');
  const chat = await post<AiSessionView>('/ai/sessions', { scope: { kind: 'space', spaceKey: 'BIG' } });
  const answered = await post<AiSessionView>(`/ai/sessions/${chat.id}/messages`, {
    prompt: 'how do I roll back a failed deploy?',
  });
  return { status, missing: after.missing, answered };
}
