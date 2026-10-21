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

// A page's attachments are read with it (ADR-066): its text attachments reach the AI wherever the
// page does, pass the leak guard like its text, and never leave the machine for an excluded page.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSessionView, BranchRun, SyncProgress } from '../src/api/types.js';
import type { GuardedPayload } from '../src/ai/guard.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp, type TestApp } from './support/testApp.js';

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(() => fake.close());

const NOTES = 'Capacity planning notes for 2026.';

/** Answers a review with one suggestion on Architecture Overview, and an edit with a small change. */
const reviewer = (payload: GuardedPayload): string => {
  const text = [payload.system, ...payload.messages.map((m) => m.content)].join('\n');
  if (text.includes('<<<PROPOSED_MARKDOWN>>>'))
    return '<<<CRITIQUE>>>\n- None\n<<<CHANGELOG>>>\n- Noted capacity\n<<<PROPOSED_MARKDOWN>>>\nCapacity is planned yearly.';
  if (payload.messages.at(-1)?.content.includes('"findings"'))
    return JSON.stringify({
      findings: [{ kind: 'depth', pages: ['Architecture Overview'], detail: 'Say how capacity is planned' }],
    });
  return 'An answer.';
};

async function withSynced(run: (app: TestApp) => Promise<void>, spaceKey = 'PLAT'): Promise<void> {
  const app = await startTestApp(fake, reviewer);
  try {
    const { body } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey });
    for (let s = 'running'; s === 'running' || s === 'pending';)
      // eslint-disable-next-line no-await-in-loop -- polling waits for the sync
      s = (await app.call<SyncProgress>('GET', `/space-cache/sync/status/${body.jobId}`)).body.status;
    await run(app);
  } finally {
    await app.close();
  }
}
const pageChat = async (app: TestApp, title: string): Promise<AiSessionView> =>
  (
    await app.call<AiSessionView>('POST', '/ai/sessions', {
      scope: { kind: 'page', spaceKey: 'PLAT', pageId: fake.page('PLAT', title).id },
    })
  ).body;
const attachment = (app: TestApp, name: string): string =>
  path.join(
    app.dataDir,
    'spaces',
    'PLAT',
    'pages',
    'Platform Engineering Home',
    'Architecture Overview_attachments',
    name,
  );

describe("a page's text attachments", () => {
  it('reach the AI with the page in a chat, where they were never read', async () => {
    await withSynced(async (app) => {
      const chat = await pageChat(app, 'Architecture Overview');
      await app.call('POST', `/ai/sessions/${chat.id}/messages`, { prompt: 'What does the capacity note say?' });
      expect(app.sentText()).toContain('## Attachment: capacity-notes.txt');
      expect(app.sentText()).toContain(NOTES);
      // An image is not text; it is never sent as characters.
      expect(app.sentText()).not.toContain('## Attachment: architecture-diagram.png');
    });
  });

  it('are found by a question about the space, as sections of their page', async () => {
    await withSynced(async (app) => {
      const chat = (
        await app.call<AiSessionView>('POST', '/ai/sessions', { scope: { kind: 'space', spaceKey: 'OPS' } })
      ).body;
      const { body } = await app.call<AiSessionView>('POST', `/ai/sessions/${chat.id}/messages`, {
        prompt: 'What are the cpu and mem figures for gateway and billing?',
      });
      expect(body.turns.at(-1)?.matchedPages?.map((p) => p.title)).toContain('Capacity Planning');
      expect(app.sentText()).toContain('gateway,4,8');
    }, 'OPS');
  });

  it('are read by the AI index with their page', async () => {
    await withSynced(async (app) => {
      const id = fake.page('PLAT', 'Architecture Overview').id;
      await app.call('POST', `/space-cache/PLAT/pages/${id}/metadata/generate`, {});
      expect(app.sentText()).toContain(NOTES);
    });
  });

  it('are given to the model writing an edit, to read but not to edit', async () => {
    await withSynced(async (app) => {
      const chat = await pageChat(app, 'Architecture Overview');
      const reviewed = (await app.call<AiSessionView>('POST', `/ai/sessions/${chat.id}/suggest`, { kind: 'review' }))
        .body;
      const before = app.sent.length;
      const { body } = await app.call<BranchRun>('POST', `/ai/sessions/${chat.id}/suggestions/recommend`, {
        ids: [reviewed.suggestions![0].id],
      });
      for (let run = body; run.status === 'running';)
        // eslint-disable-next-line no-await-in-loop -- polling waits for the edit
        run = (await app.call<BranchRun>('GET', `/branches/runs/${body.id}`)).body;
      const edit = app.sent
        .slice(before)
        .map((p) => p.system)
        .find((t) => t.includes('<<<PROPOSED_MARKDOWN>>>'));
      expect(edit).toContain('never edit them or copy them into the page');
      expect(edit).toContain(NOTES);
    });
  });

  it('pass the leak guard like page text: a secret in one stops the page being sent', async () => {
    await withSynced(async (app) => {
      fs.writeFileSync(attachment(app, 'capacity-notes.txt'), `key ${['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')}\n`);
      const chat = await pageChat(app, 'Architecture Overview');
      const asked = await app.call('POST', `/ai/sessions/${chat.id}/messages`, { prompt: 'What is in the note?' });
      expect(asked.status).toBe(422);
      expect(app.sentText()).not.toContain('IOSFODNN7');
    });
  });

  it('never leave the machine for a page excluded after it was synced', async () => {
    await withSynced(async (app) => {
      await app.call('POST', '/space-cache/PLAT/ignore', { patterns: ['Architecture Overview'], purge: false });
      const chat = (
        await app.call<AiSessionView>('POST', '/ai/sessions', { scope: { kind: 'space', spaceKey: 'PLAT' } })
      ).body;
      await app.call('POST', `/ai/sessions/${chat.id}/messages`, { prompt: 'What are the capacity planning notes?' });
      expect(app.sentText()).not.toContain(NOTES);
    });
  });
});

describe("a space's images", () => {
  const ask = async (app: TestApp, prompt = 'What does the diagram show?'): Promise<AiSessionView> => {
    const chat = await pageChat(app, 'Architecture Overview');
    return (await app.call<AiSessionView>('POST', `/ai/sessions/${chat.id}/messages`, { prompt })).body;
  };
  const choose = (app: TestApp, images: string): Promise<{ status: number }> =>
    app.call('POST', '/space-cache/PLAT/space-settings', { images });

  it('are never sent until the space chooses to, and the answer says how many it did not see', async () => {
    await withSynced(async (app) => {
      const answered = await ask(app);
      expect(answered.turns.at(-1)?.images).toEqual({ found: 1, sent: 0, choice: 'ask' });
      expect(app.sent.some((p) => p.images?.length)).toBe(false);
      await choose(app, 'skip');
      expect((await ask(app)).turns.at(-1)?.images).toEqual({ found: 1, sent: 0, choice: 'skip' });
      expect(app.sent.some((p) => p.images?.length)).toBe(false);
    });
  });

  it('are sent with the page once the space chooses, each named as unchecked by the leak guard', async () => {
    await withSynced(async (app) => {
      await choose(app, 'send');
      const turn = (await ask(app)).turns.at(-1)!;
      expect(turn.images).toEqual({ found: 1, sent: 1, choice: 'send' });
      expect(app.sent.at(-1)?.images?.map((i) => i.name)).toEqual(['Architecture Overview / architecture-diagram.png']);
      expect(turn.guardSummary).toContain(
        'Sent without leak-guard checks, as images: Architecture Overview / architecture-diagram.png',
      );
      expect(turn.sent?.images).toBe(1);
    });
  });

  it('go with the edit of their page and with its index run, once the space sends them', async () => {
    await withSynced(async (app) => {
      await choose(app, 'send');
      const chat = await pageChat(app, 'Architecture Overview');
      const reviewed = (await app.call<AiSessionView>('POST', `/ai/sessions/${chat.id}/suggest`, { kind: 'review' }))
        .body;
      const { body } = await app.call<BranchRun>('POST', `/ai/sessions/${chat.id}/suggestions/recommend`, {
        ids: [reviewed.suggestions![0].id],
      });
      let run = body;
      while (run.status === 'running')
        // eslint-disable-next-line no-await-in-loop -- polling waits for the edit
        run = (await app.call<BranchRun>('GET', `/branches/runs/${body.id}`)).body;
      expect(run.items[0].images).toEqual({ found: 1, sent: 1, choice: 'send' });
      const before = app.sent.length;
      await app.call(
        'POST',
        `/space-cache/PLAT/pages/${fake.page('PLAT', 'Architecture Overview').id}/metadata/generate`,
        {},
      );
      expect(app.sent.slice(before).some((p) => p.images?.length === 1)).toBe(true);
    });
  });

  it('are counted for the coverage line with the choice, and a choice that is not one is refused', async () => {
    await withSynced(async (app) => {
      const id = fake.page('PLAT', 'Architecture Overview').id;
      const { body } = await app.call<{ images: unknown }>('POST', '/space-cache/PLAT/metadata/coverage', {
        pageIds: [id],
      });
      expect(body.images).toEqual({ found: 1, choice: 'ask' });
      expect((await choose(app, 'maybe')).status).toBe(400);
    });
  });

  it('leave out one too large to send, and name it', async () => {
    await withSynced(async (app) => {
      await choose(app, 'send');
      fs.writeFileSync(attachment(app, 'architecture-diagram.png'), Buffer.alloc(6 * 1024 * 1024));
      const turn = (await ask(app)).turns.at(-1)!;
      expect(turn.images).toEqual({ found: 1, sent: 0, choice: 'send' });
      expect(app.sent.at(-1)?.images).toBeUndefined();
    });
  });
});
