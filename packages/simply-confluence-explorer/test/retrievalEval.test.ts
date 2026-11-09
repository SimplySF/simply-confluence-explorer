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
// about 3,000 generated pages that use the same words (design doc 0008), and how often it reaches the
// area of a deep space that holds an answer (design doc 0017). The scores may rise; a change that
// lowers either fails here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PageDetail } from '../src/api/types.js';
import { retrieveContext } from '../src/spaces/contextRetriever.js';
import { ExclusionManager } from '../src/spaces/exclusionManager.js';
import { SearchIndex } from '../src/spaces/searchIndex.js';
import { SpaceStore } from '../src/spaces/spaceStore.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { writeDeepSpace } from './support/largeSpace.js';
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
 * Keyword search alone scored 13 of 18; comparing words by their stem raised it to 16, and matching
 * the titles of the pages above each page raised it to 17.
 */
const FLOOR = 17 / 18;

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
    await index.ready('PLAT');
    const pages = await store.visiblePages('PLAT');
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

/**
 * Questions about a deep space, each with the directory whose area holds the answer and the page in
 * it that answers. Some name the area only by a directory's title ("payments", "identity",
 * "onboarding", "field app"), a word the answering page's own title and text never use; others share
 * most of their words with the 400 release notes, which then crowd out the page that answers.
 */
const AREA_QUESTIONS: Array<[question: string, area: string, answer: string]> = [
  ['how does the payments area handle refunds', 'Payments', 'Card returns'],
  ['how often do we retry a failed refund to a card', 'Payments', 'Retry schedule'],
  ['how are offline edits merged when the phone reconnects', 'Offline mode', 'Merge rules'],
  ['what storage limits does the field app set', 'Field app', 'Device limits'],
  ['how long does a single sign-on session last', 'Single sign-on', 'Session lifetime'],
  ['what does the identity area require for service accounts', 'Identity', 'Machine users'],
  ['in which region is customer data for a european tenant stored', 'Data residency', 'Where tenants live'],
  ['which laptop does a new starter get', 'Equipment', 'Laptop choices'],
  ['what does onboarding cover in the first days', 'Onboarding', 'Day one'],
];

/**
 * How many area-recall questions read at least one page of the answer's area, and how many read the
 * answering page itself, at or above which this test passes. A directory page counts toward reaching
 * its area, though it rarely holds the answer, which is why both are measured. Keyword search over
 * each page's own words reached 7 areas and 3 answering pages; matching the titles of the pages
 * above each page raised both to 8. The planned retrieval of design doc 0017, which searches the
 * areas a plan chooses, is expected to raise them further: the question left, about service
 * accounts, is lost among release notes that share its words.
 */
const AREA_FLOOR = { areas: 8, answers: 8 };

describe('area recall on a deep space', () => {
  it('reaches the area and the page that hold each answer at least as often as it did', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-deep-'));
    try {
      const exclusions = new ExclusionManager(dataDir, () => undefined);
      const store = new SpaceStore(dataDir, exclusions, () => undefined);
      const ids = writeDeepSpace(store, 'DEEP');
      const index = new SearchIndex(store);
      await index.ready('DEEP');
      const pages = await store.visiblePages('DEEP');
      const byId = new Map(pages.map((p) => [p.id, p]));
      const lines: string[] = [];
      const reached = { areas: 0, answers: 0 };
      for (const [question, area, answer] of AREA_QUESTIONS) {
        const areaId = ids.get(area)!;
        const inArea = (id: string): boolean => id === areaId || !!byId.get(id)?.ancestors.some((a) => a.id === areaId);
        // eslint-disable-next-line no-await-in-loop -- each question in turn
        const r = await retrieveContext(
          'DEEP',
          pages,
          { question },
          { store, exclusions, index, dataDir },
          { budget: 20_000 },
        );
        expect(r.corpus.mode).toBe('retrieved');
        const found = r.selectedPages.filter((p) => inArea(p.id)).length;
        const answered = r.selectedPages.some((p) => p.id === ids.get(answer));
        if (found) reached.areas++;
        if (answered) reached.answers++;
        lines.push(
          `${found} of ${r.selectedPages.length} pages in ${area}, answer ${answered ? 'read' : 'missed'} · ${question}`,
        );
      }
      const report = `areas ${reached.areas} of 9, answers ${reached.answers} of 9:\n${lines.join('\n')}`;
      // Printed, so a change to retrieval can report the numbers before and after it.
      process.stdout.write(`area recall: ${report}\n`);
      expect(reached.areas, report).toBeGreaterThanOrEqual(AREA_FLOOR.areas);
      expect(reached.answers, report).toBeGreaterThanOrEqual(AREA_FLOOR.answers);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
