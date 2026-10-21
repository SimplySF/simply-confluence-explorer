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

// A chat owns its review queue (ADR-060): the chat rewords and removes its suggestions, edits are
// made from the page as Confluence holds it now with stale suggestions checked again (ADR-061), the
// chat revises an open edit, and only the pages a person staged are pushed.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSessionView, BranchFinding, BranchRun, ChatQueue, StagedPage } from '../src/api/types.js';
import type { GuardedPayload } from '../src/ai/guard.js';
import { ExclusionManager } from '../src/spaces/exclusionManager.js';
import { SpaceStore } from '../src/spaces/spaceStore.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp, type TestApp } from './support/testApp.js';

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(() => fake.close());

const FINDINGS: BranchFinding[] = [
  {
    kind: 'redundant',
    pages: ['Interviews', 'Interview Guide'],
    detail: 'Both describe the loop',
    suggestion: 'Keep one',
  },
  { kind: 'clarity', pages: ['Interview Guide'], detail: 'The opening is vague', suggestion: 'Say who it is for' },
  { kind: 'gap', pages: [], detail: 'No page on offers', suggestion: 'Write one' },
];

const textOf = (payload: GuardedPayload): string =>
  [payload.system, ...payload.messages.map((m) => m.content)].join('\n');
const question = (payload: GuardedPayload): string => payload.messages.at(-1)?.content ?? '';
/** The ids the chat's queue lists in the context, in order. */
const queueIds = (payload: GuardedPayload): string[] =>
  [...textOf(payload).matchAll(/^#([0-9a-f]{12}) /gm)].map((m) => m[1]);

let edits = 0;
/** What the stand-in AI says the freshness check finds; every suggestion still applies unless set. */
let verdict = 'applies';
const answer = (payload: GuardedPayload): string => {
  const text = textOf(payload);
  const ask = question(payload);
  if (text.includes('<<<PROPOSED_MARKDOWN>>>'))
    return `<<<CRITIQUE>>>\n- None\n<<<CHANGELOG>>>\n- Applied\n<<<PROPOSED_MARKDOWN>>>\nImproved body ${++edits}.`;
  if (text.includes('"verdicts"'))
    return JSON.stringify({ verdicts: [{ n: 1, verdict, why: 'The page says it now.' }] });
  if (ask.includes('"findings"')) return JSON.stringify({ findings: FINDINGS });
  const [first, , gap] = queueIds(payload);
  if (ask.startsWith('Reword'))
    return `Done.\n<<<SUGGESTIONS>>>\nupdate #${first} {"detail":"Both pages walk through the loop","suggestion":"Keep it in Interviews"}\nremove #${gap}\nadd {"kind":"stale","pages":["Interview Guide"],"detail":"Old panel size"}\n<<<END SUGGESTIONS>>>`;
  if (ask.startsWith('Add a twin'))
    return 'Added.\n<<<SUGGESTIONS>>>\nadd {"kind":"structure","pages":["Interview Guide"],"detail":"The opening is vague","suggestion":"Move the purpose up"}\n<<<END SUGGESTIONS>>>';
  if (ask.startsWith('Shorter')) return 'Shortened.\n<<<EDIT>>>\nA shorter body.\n<<<END EDIT>>>';
  return 'An answer.';
};

async function withApp(run: (app: TestApp) => Promise<void>): Promise<void> {
  const app = await startTestApp(fake, answer);
  try {
    await run(app);
  } finally {
    verdict = 'applies';
    await app.close();
  }
}

const guide = (): string => fake.page('PEOPLE', 'Interview Guide').id;
const interviews = (): string => fake.page('PEOPLE', 'Interviews').id;

async function reviewedChat(app: TestApp): Promise<AiSessionView> {
  const chat = (
    await app.call<AiSessionView>('POST', '/ai/sessions', {
      scope: { kind: 'branch', spaceKey: 'PEOPLE', pageId: interviews(), title: 'Interviews' },
    })
  ).body;
  return (await app.call<AiSessionView>('POST', `/ai/sessions/${chat.id}/suggest`, { kind: 'review' })).body;
}
const ask = async (
  app: TestApp,
  id: string,
  prompt: string,
  focus?: unknown,
): Promise<{ status: number; body: AiSessionView }> =>
  app.call<AiSessionView>('POST', `/ai/sessions/${id}/messages`, { prompt, ...(focus ? { focus } : {}) });
const queueOf = async (app: TestApp, id: string): Promise<ChatQueue> =>
  (await app.call<ChatQueue>('GET', `/ai/sessions/${id}/queue`)).body;

async function settled(app: TestApp, id: string): Promise<BranchRun> {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
    const run = (await app.call<BranchRun>('GET', `/branches/runs/${id}`)).body;
    if (run.status !== 'running') return run;
    // eslint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function recommended(app: TestApp, chat: AiSessionView, picks: number[]): Promise<BranchRun> {
  const ids = picks.map((i) => chat.suggestions![i].id);
  const res = await app.call<BranchRun>('POST', `/ai/sessions/${chat.id}/suggestions/recommend`, { ids });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return settled(app, res.body.id);
}
const acceptAll = (app: TestApp, run: BranchRun, pageId: string): Promise<{ status: number; body: BranchRun }> =>
  app.call<BranchRun>('POST', `/branches/runs/${run.id}/items/${pageId}/decide-all`, { decision: 'accept' });
const stage = (
  app: TestApp,
  run: BranchRun,
  pageId: string,
  staged = true,
): Promise<{ status: number; body: BranchRun }> =>
  app.call<BranchRun>('POST', `/branches/runs/${run.id}/items/${pageId}/stage`, { staged });
const itemOf = (run: BranchRun, pageId: string): BranchRun['items'][number] =>
  run.items.find((i) => i.pageId === pageId)!;

describe("a chat's review queue", () => {
  it('is reworded, added to and trimmed by the chat when asked, each earlier wording kept and restorable', async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const [first, , gap] = chat.suggestions!;
      const { body: after } = await ask(app, chat.id, 'Reword the first, drop the gap, and add the panel size');
      expect(after.turns.at(-1)).toMatchObject({ text: 'Done.', queued: { added: 1, updated: 1, removed: 1 } });
      const reworded = after.suggestions!.find((s) => s.id === first.id)!;
      expect(reworded).toMatchObject({
        detail: 'Both pages walk through the loop',
        suggestion: 'Keep it in Interviews',
      });
      expect(reworded.history).toEqual([{ detail: first.detail, suggestion: first.suggestion, turn: 3 }]);
      expect(after.suggestions!.at(-1)).toMatchObject({ kind: 'stale', pageIds: { 'Interview Guide': guide() } });
      expect((await queueOf(app, chat.id)).suggestions.map((s) => s.state)).toEqual([
        'open',
        'open',
        'dismissed',
        'open',
      ]);

      const reverted = await app.call<ChatQueue>('POST', `/ai/sessions/${chat.id}/suggestions/${first.id}/revert`, {
        to: 0,
      });
      expect(reverted.body.suggestions[0]).toMatchObject({ detail: first.detail, suggestion: first.suggestion });
      expect(reverted.body.suggestions[0].history).toHaveLength(2);
      const back = await app.call<ChatQueue>('POST', `/ai/sessions/${chat.id}/suggestions/dismiss`, {
        ids: [gap.id],
        undo: true,
      });
      expect(back.body.suggestions[2].state).toBe('open');
    });
  });

  it('names an edit made from an earlier wording of a suggestion the chat has since reworded', async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const run = await recommended(app, chat, [0]);
      expect((await queueOf(app, chat.id)).suggestions[0]).toMatchObject({ state: 'edited', runId: run.id });
      await ask(app, chat.id, 'Reword the first');
      expect((await queueOf(app, chat.id)).suggestions[0]).toMatchObject({ state: 'edited', outdated: true });
    });
  });

  it('holds the suggestions an older chat kept on its answers', async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const file = path.join(app.dataDir, 'data', 'sessions', `${chat.id}.json`);
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as AiSessionView & Record<string, unknown>;
      // As a chat was saved before it had a queue: the suggestions and runs on its answer.
      delete stored.suggestions;
      Object.assign(stored.turns[1], {
        findings: FINDINGS,
        pageIds: { Interviews: interviews() },
        runIds: ['00000000-0000-4000-8000-000000000000'],
      });
      delete stored.turns[1].queued;
      fs.writeFileSync(file, JSON.stringify(stored));
      const read = (await app.call<AiSessionView>('GET', `/ai/sessions/${chat.id}`)).body;
      expect(read.suggestions?.map((s) => s.detail)).toEqual(FINDINGS.map((f) => f.detail));
      expect(read.suggestions?.[0].pageIds).toEqual({ Interviews: interviews() });
      expect(read.runIds).toEqual(['00000000-0000-4000-8000-000000000000']);
      expect(read.turns[1]).toMatchObject({ queued: { added: 3 } });
      expect(read.turns[1]).not.toHaveProperty('findings');
    });
  });
});

describe('an edit made from suggestions', () => {
  it('is made from the page as Confluence holds it now, and refreshes the copy on this machine', async () => {
    await withApp(async (app) => {
      const { body } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey: 'PEOPLE' });
      for (let s = 'running'; s === 'running' || s === 'pending';) {
        // eslint-disable-next-line no-await-in-loop -- polling waits for the sync
        s = (await app.call<{ status: string }>('GET', `/space-cache/sync/status/${body.jobId}`)).body.status;
      }
      const chat = await reviewedChat(app);
      const page = fake.page('PEOPLE', 'Interview Guide');
      const saved = { storage: page.storage, version: page.version };
      page.storage = '<p>Rewritten by a colleague.</p>';
      page.version++;
      try {
        const run = await recommended(app, chat, [1]);
        const item = itemOf(run, guide());
        expect(item.baseVersion).toBe(page.version);
        expect(item.original).toContain('Rewritten by a colleague.');
        expect(item.freshness).toMatchObject({ version: page.version, verdicts: [{ verdict: 'applies' }] });
        const store = new SpaceStore(app.dataDir, new ExclusionManager(app.dataDir, () => undefined), () => undefined);
        expect(store.readPage('PEOPLE', guide())?.version).toBe(page.version);
      } finally {
        Object.assign(page, saved);
      }
    });
  });

  it('does not apply a suggestion the page has carried out since it was made, and says so', async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const page = fake.page('PEOPLE', 'Interview Guide');
      page.version++;
      verdict = 'done';
      try {
        const before = app.sent.length;
        const run = await recommended(app, chat, [1]);
        expect(itemOf(run, guide())).toMatchObject({
          status: 'skipped',
          freshness: { verdicts: [{ verdict: 'done' }] },
        });
        expect(app.sent.slice(before).some((p) => textOf(p).includes('<<<PROPOSED_MARKDOWN>>>'))).toBe(false);
        expect((await queueOf(app, chat.id)).suggestions[1]).toMatchObject({
          state: 'done',
          why: 'The page says it now.',
        });
      } finally {
        page.version--;
      }
    });
  });

  it('applies a suggestion still needed when another one worded the same is already done', async () => {
    await withApp(async (app) => {
      const reviewed = await reviewedChat(app);
      const { body: chat } = await ask(app, reviewed.id, 'Add a twin of the vague-opening suggestion');
      const twin = chat.suggestions!.at(-1)!;
      const page = fake.page('PEOPLE', 'Interview Guide');
      page.version++;
      verdict = 'done';
      try {
        const run = await recommended(app, chat, [1, chat.suggestions!.length - 1]);
        const item = itemOf(run, guide());
        expect(item.status).toBe('proposed');
        expect(item.fixes?.map((f) => f.suggestionId)).toEqual([twin.id]);
      } finally {
        page.version--;
      }
    });
  });

  it('asks nothing again about a page that has not changed since the suggestion', async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const before = app.sent.length;
      const run = await recommended(app, chat, [1]);
      expect(itemOf(run, guide()).status).toBe('proposed');
      expect(app.sent.slice(before).some((p) => textOf(p).includes('"verdicts"'))).toBe(false);
    });
  });
});

describe('an edit open in its chat', () => {
  it("is revised by the chat, and the revision accepted becomes changes to decide that count as the AI's", async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const run = await recommended(app, chat, [1]);
      const focus = { runId: run.id, pageId: guide() };
      const { body: answered } = await ask(app, chat.id, 'Shorter, please', focus);
      const turn = answered.turns.length - 1;
      expect(answered.turns[turn]).toMatchObject({
        text: 'Shortened.',
        proposedEdit: { runId: run.id, pageId: guide(), text: 'A shorter body.' },
      });
      expect(app.sent.at(-1)!.messages[0].content).toContain('[Edit of: Interview Guide]');
      const accepted = await app.call<{ run: BranchRun; session: AiSessionView }>(
        'POST',
        `/ai/sessions/${chat.id}/turns/${turn}/accept-edit`,
      );
      const item = itemOf(accepted.body.run, guide());
      expect(item.proposed).toBe('A shorter body.');
      expect(item.changes?.map((c) => c.source)).toEqual(['ai']);
      expect(accepted.body.session.turns[turn].proposalClosed).toBe(true);
      expect((await app.call('POST', `/ai/sessions/${chat.id}/turns/${turn}/accept-edit`)).status).toBe(404);
    });
  });

  it('is not changed by a revision the person dismissed', async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const run = await recommended(app, chat, [1]);
      const { body } = await ask(app, chat.id, 'Shorter, please', { runId: run.id, pageId: guide() });
      const turn = body.turns.length - 1;
      await app.call('POST', `/ai/sessions/${chat.id}/turns/${turn}/close-proposal`);
      expect((await app.call('POST', `/ai/sessions/${chat.id}/turns/${turn}/accept-edit`)).status).toBe(404);
      expect(itemOf(await settled(app, run.id), guide()).proposed).toMatch(/^Improved body/);
    });
  });

  it('is sent only while its page is allowed, checked on every turn', async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const run = await recommended(app, chat, [1]);
      await app.call('POST', '/space-cache/PEOPLE/ignore', { patterns: [`id:${guide()}`], purge: false });
      const before = app.sent.length;
      const refused = await ask(app, chat.id, 'Shorter, please', { runId: run.id, pageId: guide() });
      expect(refused.status).toBe(403);
      expect(app.sent.length).toBe(before);
    });
  });

  it("must be one of this chat's, and a revision without an open edit is not taken", async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const run = await recommended(app, chat, [1]);
      const other = await reviewedChat(app);
      expect((await ask(app, other.id, 'Shorter', { runId: run.id, pageId: guide() })).status).toBe(404);
      const { body } = await ask(app, chat.id, 'Shorter, please');
      expect(body.turns.at(-1)?.proposedEdit).toBeUndefined();
    });
  });
});

describe('staged pages', () => {
  it('are the only pages pushed; an accepted page that was not staged is not written', async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const run = await recommended(app, chat, [0]);
      await acceptAll(app, run, guide());
      await acceptAll(app, run, interviews());
      expect((await stage(app, run, guide())).status).toBe(200);
      const before = fake.writes.length;
      const pushed = (await app.call<BranchRun>('POST', `/branches/runs/${run.id}/push`)).body;
      expect(fake.writes.slice(before)).toEqual([guide()]);
      expect(itemOf(pushed, interviews()).status).toBe('accepted');
    });
  });

  it('are pushed only as far as a push names them', async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const run = await recommended(app, chat, [0]);
      for (const id of [guide(), interviews()]) {
        // eslint-disable-next-line no-await-in-loop -- one page at a time
        await acceptAll(app, run, id);
        // eslint-disable-next-line no-await-in-loop -- as above
        await stage(app, run, id);
      }
      const before = fake.writes.length;
      await app.call('POST', `/branches/runs/${run.id}/check`, { pageIds: [interviews()] });
      const pushed = (await app.call<BranchRun>('POST', `/branches/runs/${run.id}/push`, { pageIds: [guide()] })).body;
      expect(fake.writes.slice(before)).toEqual([guide()]);
      expect(itemOf(pushed, interviews())).toMatchObject({ status: 'checked', staged: true });
    });
  });

  it('cannot be staged undecided, and are unstaged by a later decision', async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const run = await recommended(app, chat, [1]);
      expect((await stage(app, run, guide())).status).toBe(409);
      const decided = (await acceptAll(app, run, guide())).body;
      await stage(app, run, guide());
      const change = itemOf(decided, guide()).changes![0];
      const undone = await app.call<BranchRun>(
        'PATCH',
        `/branches/runs/${run.id}/items/${guide()}/changes/${change.id}`,
        {
          decision: 'undo',
        },
      );
      expect(itemOf(undone.body, guide()).staged).toBe(false);
    });
  });

  it('are listed for the space with their chat, never an excluded page', async () => {
    await withApp(async (app) => {
      const chat = await reviewedChat(app);
      const run = await recommended(app, chat, [0]);
      for (const id of [guide(), interviews()]) {
        // eslint-disable-next-line no-await-in-loop -- one page at a time
        await acceptAll(app, run, id);
        // eslint-disable-next-line no-await-in-loop -- as above
        await stage(app, run, id);
      }
      const listed = async (): Promise<StagedPage[]> =>
        (await app.call<{ staged: StagedPage[] }>('GET', '/space-cache/PEOPLE/staged')).body.staged;
      expect((await listed()).map((p) => [p.title, p.chatTitle])).toEqual([
        ['Interviews', 'Review these pages for problems'],
        ['Interview Guide', 'Review these pages for problems'],
      ]);
      await app.call('POST', '/space-cache/PEOPLE/ignore', { patterns: [`id:${guide()}`], purge: false });
      expect((await listed()).map((p) => p.title)).toEqual(['Interviews']);
    });
  });
});
