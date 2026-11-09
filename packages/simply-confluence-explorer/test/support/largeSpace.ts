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

/** A page of the deep space as written: its title, its sections' text, and the pages below it. */
type DeepPage = { title: string; text: string[]; children?: DeepPage[] };
type Place = { id: string; title: string };

/**
 * The deep space's functional areas. Each answer sits four or five levels down. Most answering pages
 * have plain titles such as "Card returns", so a question that names its area ("payments") meets
 * that word only in the titles of the directories above them.
 */
const AREAS: DeepPage[] = [
  {
    title: 'Engineering handbook',
    text: ['How the engineering teams work, and where each team keeps its pages.'],
    children: [
      {
        title: 'Platform',
        text: ['The shared services every product is built on.'],
        children: [
          {
            title: 'Commerce',
            text: ['The services that take money in and send it back out.'],
            children: [
              {
                title: 'Payments',
                text: ['The ledger team owns this directory.'],
                children: [
                  {
                    title: 'Refunds',
                    text: ['How money goes back to a customer.'],
                    children: [
                      {
                        title: 'Card returns',
                        text: [
                          'Money goes back to the original card within five working days.',
                          'A return above 500 credits needs a second approver from the ledger team.',
                        ],
                      },
                      {
                        title: 'Retry schedule',
                        text: [
                          'A return that the issuer declines is attempted again three times: after one hour, after six hours and after one day.',
                          'After the third attempt the ledger team is paged and the customer is told by email.',
                        ],
                      },
                    ],
                  },
                  {
                    title: 'Chargeback evidence',
                    text: [
                      'A dispute is answered within seven days with the receipt, the delivery record and the chat log.',
                    ],
                  },
                  {
                    title: 'Payout timing',
                    text: ['Merchants are paid every Tuesday for the week before, less the fees of that week.'],
                  },
                ],
              },
            ],
          },
          {
            title: 'Security',
            text: ['How the platform proves who is calling it.'],
            children: [
              {
                title: 'Identity',
                text: ['The identity team owns sign-in and machine users.'],
                children: [
                  {
                    title: 'Single sign-on',
                    text: ['Every staff tool signs in through the company directory.'],
                    children: [
                      {
                        title: 'Session lifetime',
                        text: [
                          'A sign-on session lasts eight hours, and is renewed while the person keeps working.',
                          'After twelve hours the person is asked for a second factor again.',
                        ],
                      },
                    ],
                  },
                  {
                    title: 'Machine users',
                    text: [
                      'Each automated caller gets its own key, which is rotated every ninety days.',
                      'A key is never shared between two pipelines, and a human owner is named for each one.',
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    title: 'Product',
    text: ['What each product does and how it is meant to behave.'],
    children: [
      {
        title: 'Mobile apps',
        text: ['The apps people carry with them.'],
        children: [
          {
            title: 'Field app',
            text: ['The app the inspectors use on site.'],
            children: [
              {
                title: 'Offline mode',
                text: ['What the app does without a connection.'],
                children: [
                  {
                    title: 'Merge rules',
                    text: [
                      'When the device reconnects, each changed form is merged field by field.',
                      'Where both sides changed one field, the later change wins and the other is kept as a comment.',
                    ],
                  },
                ],
              },
              {
                title: 'Device limits',
                text: ['Each device keeps at most 2 GB of drawings and photos, and drops the oldest first.'],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    title: 'Operations',
    text: ['How the systems are run day to day.'],
    children: [
      {
        title: 'Infrastructure',
        text: ['Hosting, networks and the places data is kept.'],
        children: [
          {
            title: 'Regions',
            text: ['Where the platform runs.'],
            children: [
              {
                title: 'Data residency',
                text: ['Which copy of a tenant lives where.'],
                children: [
                  {
                    title: 'Where tenants live',
                    text: [
                      'A tenant whose contract names the European Union is kept in Frankfurt, with its backups in Dublin.',
                      'Every other tenant is kept in Virginia.',
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    title: 'People',
    text: ['Joining, working here and leaving.'],
    children: [
      {
        title: 'Onboarding',
        text: ['The path a new colleague takes.'],
        children: [
          {
            title: 'First week',
            text: ['What happens in the first five days.'],
            children: [
              {
                title: 'Day one',
                text: ['A buddy meets the new colleague, and the afternoon is spent on the security course.'],
              },
              {
                title: 'Equipment',
                text: ['What a new starter is given.'],
                children: [
                  {
                    title: 'Laptop choices',
                    text: [
                      'Engineers get a 16-inch laptop with 32 GB of memory; everyone else gets the 14-inch model.',
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];

/** The fixes a release note lists, which share many words with the area-recall questions. */
const RELEASE_LINES = [
  'Fixed: a failed refund retry fired before the card issuer answered.',
  'Changed: refunds to a card now show in the customer history.',
  'Fixed: offline edits made on the phone were lost when it reconnected and merged.',
  'Improved: single sign-on renews the session sooner for each person.',
  'Changed: customer data exports name the region the tenant is stored in.',
  'Fixed: the laptop setup script failed for a new starter.',
  'Improved: service accounts can be filtered on the identity screen.',
  'Changed: dashboards load the last week of data first.',
];

const FILLER_WORDS =
  'deploy rollback database gateway kafka postgres runbook incident pager vpn access card session data region phone retry failed edit storage customer schedule limit owner review'.split(
    ' ',
  );
const FILLER_TOPICS = ['Gateway', 'Ledger', 'Search', 'Mobile', 'Network', 'Support', 'Billing', 'Reporting'];

/**
 * A deep generated space of about 3,200 pages, for measuring whether retrieval reaches the area that
 * holds an answer (design doc 0017): the functional areas above, four or five levels down; a series
 * of 400 release notes nested by year and minor version; a directory of templates; and filler pages
 * under every top-level directory, down to four levels below it.
 *
 * @returns The id of each page by its title, so a question's area can be found.
 */
export function writeDeepSpace(store: SpaceStore, key: string): Map<string, string> {
  const ids = new Map<string, string>();
  const write = (title: string, text: string[], ancestors: Place[]): Place => {
    const id = String(ids.size + 1);
    store.writePage(
      key,
      {
        id,
        title,
        spaceKey: key,
        parentId: ancestors.at(-1)?.id,
        version: 1,
        author: 'a',
        lastModified: '2026-01-01',
        storageXml: text.map((t, s) => `<h2>Part ${s}</h2><p>${t}</p>`).join(''),
        labels: [],
        attachments: [],
        ancestors,
      },
      '',
      [],
    );
    ids.set(title, id);
    return { id, title };
  };
  const tops: Place[] = [];
  const writeTree = (page: DeepPage, ancestors: Place[]): void => {
    const place = write(page.title, page.text, ancestors);
    if (ancestors.length === 0) tops.push(place);
    for (const child of page.children ?? []) writeTree(child, [...ancestors, place]);
  };
  AREAS.forEach((area) => writeTree(area, []));

  const notes = write('Release notes', ['Every release, newest first.'], []);
  for (let year = 0; year < 4; year++) {
    const yearPage = write(String(2022 + year), [`The releases of ${2022 + year}.`], [notes]);
    for (let minor = 0; minor < 4; minor++) {
      const series = write(`Release ${year + 1}.${minor}`, ['The patch releases of this version.'], [notes, yearPage]);
      for (let patch = 0; patch < 25; patch++) {
        const n = (year * 4 + minor) * 25 + patch;
        const lines = [0, 1, 2].map((k) => RELEASE_LINES[(n + k * 3) % RELEASE_LINES.length]);
        write(`Release ${year + 1}.${minor}.${patch} notes`, lines, [notes, yearPage, series]);
      }
    }
  }

  const templates = write('Templates', ['Pages to copy when starting a new one.'], []);
  for (let t = 0; t < 30; t++)
    write(
      `Template ${t + 1}: ${FILLER_TOPICS[t % FILLER_TOPICS.length].toLowerCase()} page`,
      [
        'Describe the owner, the schedule and the limits here.',
        'List each failed step and its retry, and who to page.',
      ],
      [templates],
    );

  // Filler hangs off the top-level directories in a tree four pages wide, so it reaches four levels
  // below them and uses the same words as the questions without answering any.
  const filler: Place[][] = [];
  const para = (seed: number): string =>
    Array.from({ length: 40 }, (_, w) => FILLER_WORDS[(seed * 7 + w * 13) % FILLER_WORDS.length]).join(' ');
  for (let f = 0; filler.length < 2720; f++) {
    const above = f < 40 ? [tops[f % tops.length]] : filler[Math.floor((f - 40) / 4)];
    const place = write(`${FILLER_TOPICS[f % FILLER_TOPICS.length]} notes ${f + 1}`, [para(f), para(f + 1)], above);
    filler.push([...above, place]);
  }
  store.writeManifest(key, { spaceKey: key, name: 'Deep', lastSynced: '2026-01-01', pageCount: ids.size });
  return ids;
}
