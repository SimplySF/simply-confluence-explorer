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
import type { AiSessionView, SessionTurn } from '../../src/api/types.js';
import { SessionStore } from '../../src/ai/sessions.js';
import { createServer } from '../../src/server.js';
import { ExclusionManager } from '../../src/spaces/exclusionManager.js';
import { SpaceStore } from '../../src/spaces/spaceStore.js';
import { pdfSaying } from './pdf.js';
import { metadataReply } from './testApp.js';
import { workbook } from './zipFiles.js';

export const PAGES = 3200;
const WORDS =
  'deploy rollback database failover gateway billing auth kafka postgres runbook incident pager vpn access'.split(' ');

/** How many saved chats the realistic space has, and how many pages a chosen directory holds. */
export const CHATS = 40;
export const DIRECTORY = '7';

/**
 * The space as a real one is: most pages labelled, every fourth page with an image, a workbook, a PDF
 * and a file listed but not downloaded, twenty exclusion rules, and saved chats, some of them long.
 */
async function realistic(dataDir: string, store: SpaceStore): Promise<void> {
  const sheet = await workbook(Array.from({ length: 200 }, (_, r) => [`row ${r}`, 'deploy', 'rollback', String(r)]));
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  const pdf = pdfSaying('Restore the database from the nightly backup, then fail over.');
  for (let i = 1; i <= PAGES; i++) {
    const page = store.readPage('BIG', String(i))!;
    const labels = [...(i % 10 ? ['ops'] : []), ...(i % 3 === 0 ? ['runbook'] : [])];
    if (i % 4) {
      store.writePage('BIG', { ...page, labels }, '', []);
      continue;
    }
    const files = [
      { name: `diagram-${i}.png`, data: png, type: 'image/png' },
      {
        name: `limits-${i}.xlsx`,
        data: sheet,
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      { name: `restore-${i}.pdf`, data: pdf, type: 'application/pdf' },
    ];
    const listed = [...files, { name: `missing-${i}.docx`, data: Buffer.alloc(0), type: 'application/msword' }];
    store.writePage(
      'BIG',
      {
        ...page,
        labels,
        attachments: listed.map((f, n) => ({
          id: `${i}-${n}`,
          title: f.name,
          mediaType: f.type,
          fileSize: f.data.length,
          downloadUrl: `/download/${f.name}`,
        })),
      },
      '',
      files.map((f) => ({ name: f.name, data: f.data })),
    );
  }
  fs.writeFileSync(
    path.join(dataDir, 'spaces', 'BIG', '.confluenceignore'),
    Array.from({ length: 20 }, (_, r) => (r % 2 ? `*Secret ${r}*` : `id:${90000 + r}`)).join('\n'),
  );
  // A busy day of telemetry: requests with their spans and logs, as Observability reads them.
  const telemetry = path.join(dataDir, 'telemetry');
  fs.mkdirSync(telemetry, { recursive: true });
  const now = Date.now();
  const lines = Array.from({ length: 100_000 }, (_, n) => {
    const at = new Date(now - (100_000 - n) * 500).toISOString();
    return JSON.stringify(
      n % 2
        ? {
            type: 'log',
            at,
            level: 'info',
            kind: 'http',
            message: `GET /api/pages/${n % 3200} answered`,
            traceId: `t${n}`,
          }
        : {
            type: 'span',
            at,
            traceId: `t${n}`,
            spanId: `s${n}`,
            kind: 'http',
            name: 'GET /api/pages/:id',
            durationMs: 12,
            outcome: 'ok',
            attrs: {},
          },
    );
  });
  fs.writeFileSync(path.join(telemetry, `${new Date(now).toISOString().slice(0, 10)}.jsonl`), `${lines.join('\n')}\n`);
  const sessions = new SessionStore(dataDir);
  const report = {
    files: 800,
    read: Array.from({ length: 400 }, (_, n) => ({ page: `Page ${n}`, name: `limits-${n}.xlsx`, as: 'Excel' })),
    unread: Array.from({ length: 400 }, (_, n) => ({
      pageId: String(n),
      page: `Page ${n}`,
      name: `missing-${n}.docx`,
      why: 'not downloaded',
    })),
    images: { found: 200, sent: 0, choice: 'ask' as const },
  };
  for (let c = 0; c < CHATS; c++) {
    const chat = sessions.create(
      c % 2
        ? { kind: 'space', spaceKey: 'BIG' }
        : { kind: 'branch', spaceKey: 'BIG', pageId: String(c + 1), title: `Page ${c + 1}` },
    );
    // A few chats are long, with an account of hundreds of attachments on every answer.
    const rounds = c % 10 === 0 ? 30 : 3;
    const turns: SessionTurn[] = Array.from({ length: rounds }, (_, t) => [
      { role: 'user' as const, text: `question ${t}`, at: '2026-01-01T00:00:00Z' },
      {
        role: 'assistant' as const,
        text: 'an answer '.repeat(200),
        at: '2026-01-01T00:00:00Z',
        ...(c % 10 === 0 ? { attachments: report } : {}),
      },
    ]).flat();
    sessions.addTurns(chat.id, turns, []);
  }
}

async function generatedSpace(options: { realistic?: boolean }): Promise<string> {
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
  if (options.realistic) await realistic(dataDir, store);
  store.writeManifest('BIG', { spaceKey: 'BIG', name: 'Big', lastSynced: '2026-01-01', pageCount: PAGES });
  return dataDir;
}

export type LargeSpace = {
  base: string;
  /** How many requests the AI index has sent. */
  indexRequests: () => number;
  close: () => Promise<void>;
};

export async function startLargeSpace(
  options: { startupIndexMs?: number; realistic?: boolean } = {},
): Promise<LargeSpace> {
  const dataDir = await generatedSpace(options);
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
    startupIndexMs: options.startupIndexMs,
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
