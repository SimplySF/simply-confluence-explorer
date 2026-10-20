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

// How well retrieval finds the page that answers a question, among the test dataset's pages and
// about 3,000 generated pages that use the same words (design doc 0008). The score may rise; a
// change that lowers it fails here.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PageDetail } from '../src/api/types.js';
import { retrieveContext } from '../src/spaces/contextRetriever.js';
import { ExclusionManager } from '../src/spaces/exclusionManager.js';
import { SearchIndex } from '../src/spaces/searchIndex.js';
import { SpaceStore } from '../src/spaces/spaceStore.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp, type TestApp } from './support/testApp.js';

/** Questions as a person would ask them, each with the page that answers it. */
const QUESTIONS: Array<[string, string]> = [
  ['how do I promote the replica when the primary database goes down', 'Database Failover'],
  ['failing over the primary', 'Database Failover'],
  ['how long are nightly backups retained', 'Database Backups'],
  ['steps to restore the database into staging', 'Restore Drill'],
  ['what severity levels do we use for an outage', 'Incident Response'],
  ['restarting the gateway pods safely', 'Gateway Runbook'],
  ['who owns the billing service and what language is it written in', 'Billing Service'],
  ['what endpoints does the auth API have', 'Auth API Reference'],
  ['what changed in gateway version 2.1', 'Gateway Changelog'],
  ['the VPN client keeps failing', 'VPN Troubleshooting'],
  ['why did we choose PostgreSQL', 'ADR-001: Use PostgreSQL'],
  ['what was decided about feature flags', 'ADR-006: Feature Flags'],
  ['how are secrets managed', 'ADR-008: Secrets Management'],
  ['auth tokens stopped working', 'INC-1003: Auth token outage'],
  ['customers were billed twice', 'INC-1002: Billing double charge'],
  ['gateway latency spiked this morning', 'INC-1001: Gateway latency spike'],
  ['which accounts do I request on my first day', 'Access Requests'],
  ['what does a postmortem need to cover', 'Postmortem Template'],
];

/**
 * The share of questions whose answering page retrieval reads, at or above which this test passes.
 * Keyword search alone scored 13 of 18; comparing words by their stem raised it to 16.
 */
const FLOOR = 16 / 18;

const WORDS =
  'database gateway billing auth backup restore replica primary service runbook incident severity api endpoint version deploy token vpn client feature decision secrets latency staging account'.split(
    ' ',
  );

let fake: FakeConfluence;
let app: TestApp;
beforeAll(async () => {
  fake = await startFakeConfluence();
  app = await startTestApp(fake);
  const { body } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey: 'PLAT' });
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
    const { body: p } = await app.call<{ status: string }>('GET', `/space-cache/sync/status/${body.jobId}`);
    if (p.status !== 'running' && p.status !== 'pending') break;
  }
}, 60_000);
afterAll(async () => {
  await app.close();
  await fake.close();
});

/** Pages that share the dataset's words without answering any of the questions. */
function addDistractors(store: SpaceStore, count: number): void {
  for (let i = 0; i < count; i++) {
    const words = (seed: number): string =>
      Array.from({ length: 40 }, (_, k) => WORDS[(seed * 11 + k * 7 + ((k * k) % 13)) % WORDS.length]).join(' ');
    const page: PageDetail = {
      id: String(900_000 + i),
      title: `${WORDS[i % WORDS.length]} notes ${i}`,
      spaceKey: 'PLAT',
      version: 1,
      author: 'a',
      lastModified: '2026-01-01',
      storageXml: `<h2>Overview</h2><p>${words(i)}</p><h2>Details</h2><p>${words(i + 3)}</p>`,
      labels: [],
      attachments: [],
      ancestors: [],
    };
    store.writePage('PLAT', page, '', []);
  }
}

describe('retrieval over a large space', () => {
  it('reads the page that answers each question at least as often as it did', async () => {
    const exclusions = new ExclusionManager(app.dataDir, () => undefined);
    const store = new SpaceStore(app.dataDir, exclusions, () => undefined);
    addDistractors(store, 3000);
    const index = new SearchIndex(store);
    const pages = store.visiblePages('PLAT');
    const missed: string[] = [];
    for (const [question, title] of QUESTIONS) {
      // eslint-disable-next-line no-await-in-loop -- each question in turn
      const r = await retrieveContext(
        'PLAT',
        pages,
        { question },
        { store, exclusions, index, dataDir: app.dataDir },
        { budget: 20_000 },
      );
      expect(r.corpus.mode).toBe('retrieved');
      if (!r.selectedPages.some((p) => p.title === title)) missed.push(`${question} → ${title}`);
    }
    const score = (QUESTIONS.length - missed.length) / QUESTIONS.length;
    expect(score, `score ${score.toFixed(2)}; missed:\n${missed.join('\n')}`).toBeGreaterThanOrEqual(FLOOR);
  }, 120_000);
});
