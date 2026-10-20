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

// Changes from a chat: its suggestions are stored with the answer, the ticked ones are staged as one
// edit per page, and nothing is written that a person did not accept, each write checked against the
// version its edit was made from (ADR-024, ADR-049).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSessionView, BranchFinding, BranchRun } from '../src/api/types.js';
import type { GuardedPayload } from '../src/ai/guard.js';
import { parseFindings, reviewPrompt } from '../src/branches/branchRuns.js';
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
    suggestion: 'Keep it in one page',
  },
  { kind: 'clarity', pages: ['Interview Guide'], detail: 'The opening is vague', suggestion: 'Say who it is for' },
  { kind: 'gap', pages: [], detail: 'No page on offers', suggestion: 'Write one' },
];

const textOf = (payload: GuardedPayload): string =>
  [payload.system, ...payload.messages.map((m) => m.content)].join('\n');

/** Answers a request for suggestions with FINDINGS, an edit with a proposal for its page, and anything else in words. */
const answer = (payload: GuardedPayload): string => {
  const text = textOf(payload);
  if (text.includes('<<<PROPOSED_MARKDOWN>>>')) {
    const title = /^# Document Title: (.+)$/m.exec(text)?.[1] ?? 'Page';
    return `<<<CRITIQUE>>>\n- None\n<<<CHANGELOG>>>\n- Applied\n<<<PROPOSED_MARKDOWN>>>\n# ${title}\n\nImproved body.`;
  }
  if (payload.messages.at(-1)?.content.includes('"findings"')) return JSON.stringify({ findings: FINDINGS });
  return 'The two pages both describe the interview loop.';
};

async function withApp(
  reply: (payload: GuardedPayload, n: number, signal?: AbortSignal) => string | Promise<string>,
  run: (app: TestApp) => Promise<void>,
): Promise<void> {
  const app = await startTestApp(fake, reply);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

async function settled(app: TestApp, id: string): Promise<BranchRun> {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
    const run = (await app.call<BranchRun>('GET', `/branches/runs/${id}`)).body;
    if (run.status !== 'running') return run;
    // eslint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const interviews = (): string => fake.page('PEOPLE', 'Interviews').id;
const guide = (): string => fake.page('PEOPLE', 'Interview Guide').id;

/** A chat on the Interviews directory: the page and everything under it. */
const directoryChat = async (app: TestApp): Promise<AiSessionView> =>
  (
    await app.call<AiSessionView>('POST', '/ai/sessions', {
      scope: { kind: 'branch', spaceKey: 'PEOPLE', pageId: interviews(), title: 'Interviews' },
    })
  ).body;
const suggest = async (app: TestApp, id: string, kind = 'review'): Promise<AiSessionView> =>
  (await app.call<AiSessionView>('POST', `/ai/sessions/${id}/suggest`, { kind })).body;
const queue = (
  app: TestApp,
  id: string,
  turn: number,
  findings: unknown[],
): Promise<{ status: number; body: BranchRun }> =>
  app.call<BranchRun>('POST', `/ai/sessions/${id}/turns/${turn}/queue`, { findings });
/** A directory chat's review, then edits staged from its first suggestion, which names both pages. */
const staged = async (app: TestApp, findings = [0]): Promise<BranchRun> => {
  const c = await directoryChat(app);
  const reviewed = await suggest(app, c.id);
  const res = await queue(app, c.id, reviewed.turns.length - 1, findings);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return settled(app, res.body.id);
};
const decide = (
  app: TestApp,
  id: string,
  pageId: string,
  decision: string,
  proposed?: string,
): Promise<{ status: number; body: BranchRun }> =>
  app.call<BranchRun>('PATCH', `/branches/runs/${id}/items/${pageId}`, { decision, proposed });

describe('suggestions in a chat', () => {
  it('are stored with the answer, with the pages it read, and never from an excluded page', async () => {
    await withApp(answer, async (app) => {
      const c = await directoryChat(app);
      const reviewed = await suggest(app, c.id);
      const turn = reviewed.turns.at(-1)!;
      expect(reviewed.turns.at(-2)?.text).toBe('Review these pages for problems');
      expect(turn.findings).toEqual(FINDINGS);
      expect(turn.pageIds).toEqual({ Interviews: interviews(), 'Interview Guide': guide() });
      expect(turn.text).toContain('3 suggestions');
      expect(app.sentText()).not.toContain('Candidate Feedback');
    });
  });

  it('ask about one page as a page, and about a directory as a set read together', () => {
    const several = reviewPrompt(['clarity', 'staleness'], 2, 'we moved to GitLab CI');
    expect(several).toContain('"clarity"');
    expect(several).toContain('"stale"');
    expect(several).not.toContain('"redundant"');
    expect(several).toContain('"placement"');
    expect(several).toContain('Also: we moved to GitLab CI');
    expect(reviewPrompt(['clarity'], 1)).not.toContain('"gap"');
  });

  it('turn a conversation into changes only once there is one', async () => {
    await withApp(answer, async (app) => {
      const c = await directoryChat(app);
      expect((await app.call('POST', `/ai/sessions/${c.id}/suggest`, { kind: 'changes' })).status).toBe(400);
      await app.call('POST', `/ai/sessions/${c.id}/messages`, { prompt: 'Do these pages repeat each other?' });
      const changed = await suggest(app, c.id, 'changes');
      expect(changed.turns.at(-1)?.findings).toEqual(FINDINGS);
      expect((await app.call('POST', `/ai/sessions/${c.id}/suggest`, { kind: 'rewrite' })).status).toBe(400);
    });
  });

  it('keep the answer as text when it is not suggestions, and drop a suggestion of an unknown kind', async () => {
    await withApp(
      () => 'Looks fine overall.',
      async (app) => {
        const c = await directoryChat(app);
        const reviewed = await suggest(app, c.id);
        expect(reviewed.turns.at(-1)?.text).toBe('Looks fine overall.');
        expect(reviewed.turns.at(-1)?.findings).toBeUndefined();
      },
    );
    expect(parseFindings('{"findings":[{"kind":"made-up","detail":"x"}]}')).toEqual([]);
  });
});

describe('queueing suggestions', () => {
  it('stages an edit of each page the chosen suggestions name, carrying only those suggestions', async () => {
    await withApp(answer, async (app) => {
      const c = await directoryChat(app);
      const reviewed = await suggest(app, c.id);
      const turn = reviewed.turns.length - 1;
      const sentBefore = app.sent.length;
      const res = await queue(app, c.id, turn, [1]);
      const run = await settled(app, res.body.id);
      expect(run.kind).toBe('improve');
      expect(run.fromSessionId).toBe(c.id);
      expect(run.items.map((i) => i.title)).toEqual(['Interview Guide']);
      expect(run.items[0].fixes).toEqual([
        { kind: 'clarity', detail: 'The opening is vague', suggestion: 'Say who it is for', otherPages: [] },
      ]);
      expect(run.items[0].baseVersion).toBe(fake.page('PEOPLE', 'Interview Guide').version);
      const sent = app.sent.slice(sentBefore).map(textOf).join('\n');
      expect(sent).toContain('The opening is vague');
      expect(sent).not.toContain('Both describe the loop');
      const after = (await app.call<AiSessionView>('GET', `/ai/sessions/${c.id}`)).body;
      expect(after.turns[turn].runIds).toEqual([run.id]);
    });
  });

  it('tells each page which other page shares a repeated passage', async () => {
    await withApp(answer, async (app) => {
      const run = await staged(app);
      expect(run.items.map((i) => [i.title, i.fixes?.[0].otherPages])).toEqual([
        ['Interviews', ['Interview Guide']],
        ['Interview Guide', ['Interviews']],
      ]);
    });
  });

  it('refuses a suggestion that is not there, one no edit can carry out, and an answer without suggestions', async () => {
    await withApp(answer, async (app) => {
      const c = await directoryChat(app);
      const reviewed = await suggest(app, c.id);
      const turn = reviewed.turns.length - 1;
      expect((await queue(app, c.id, turn, [7])).status).toBe(400);
      expect((await queue(app, c.id, turn, [])).status).toBe(400);
      expect((await queue(app, c.id, turn, [1, 2])).status).toBe(400);
      expect((await queue(app, c.id, turn, ['0'])).status).toBe(400);
      expect((await queue(app, c.id, turn - 1, [0])).status).toBe(404);
      expect((await queue(app, c.id, 99, [0])).status).toBe(404);
    });
  });

  it('leaves out a page excluded after the suggestion was made', async () => {
    await withApp(answer, async (app) => {
      const c = await directoryChat(app);
      const reviewed = await suggest(app, c.id);
      await app.call('POST', '/space-cache/PEOPLE/ignore', {
        patterns: [`id:${guide()}`, 'id:{{id:Salary Bands}}', 'Interviews/Internal/'],
        purge: false,
      });
      const res = await queue(app, c.id, reviewed.turns.length - 1, [0]);
      const run = await settled(app, res.body.id);
      expect(run.items.map((i) => i.title)).toEqual(['Interviews']);
    });
  });

  it('stops at once when stopped, ending the edit being written', async () => {
    let aborted = false;
    const reply = async (payload: GuardedPayload, _n: number, signal?: AbortSignal): Promise<string> => {
      if (textOf(payload).includes('<<<PROPOSED_MARKDOWN>>>')) {
        signal?.addEventListener('abort', () => (aborted = true));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return answer(payload);
    };
    await withApp(reply, async (app) => {
      const c = await directoryChat(app);
      const reviewed = await suggest(app, c.id);
      const res = await queue(app, c.id, reviewed.turns.length - 1, [0]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const stopped = (await app.call<BranchRun>('POST', `/branches/runs/${res.body.id}/cancel`)).body;
      expect(stopped.status).toBe('cancelled');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const after = (await app.call<BranchRun>('GET', `/branches/runs/${res.body.id}`)).body;
      expect(after.status).toBe('cancelled');
      expect(after.items.some((i) => i.status === 'proposed')).toBe(false);
      expect(aborted).toBe(true);
    });
  });
});

describe('the queued edits', () => {
  it('write only the page accepted', async () => {
    await withApp(answer, async (app) => {
      const run = await staged(app);
      expect(run.items.every((i) => i.status === 'proposed' && i.proposed?.includes('Improved body.'))).toBe(true);
      const before = fake.writes.length;

      await decide(app, run.id, guide(), 'accept', '# Interview Guide\n\nEdited by a person.');
      await decide(app, run.id, interviews(), 'reject');
      const pushed = (await app.call<BranchRun>('POST', `/branches/runs/${run.id}/push`)).body;

      expect(fake.writes.slice(before)).toEqual([guide()]);
      expect(fake.page('PEOPLE', 'Interview Guide').storage).toContain('Edited by a person.');
      expect(pushed.items.find((i) => i.pageId === guide())?.status).toBe('pushed');
      expect(pushed.items.find((i) => i.pageId === interviews())?.status).toBe('rejected');
    });
  });

  it('refuse a page that changed after its edit was made, and still write the others', async () => {
    await withApp(answer, async (app) => {
      const run = await staged(app);
      await decide(app, run.id, interviews(), 'accept');
      await decide(app, run.id, guide(), 'accept');
      fake.page('PEOPLE', 'Interviews').version++;
      const before = fake.writes.length;
      const pushed = (await app.call<BranchRun>('POST', `/branches/runs/${run.id}/push`)).body;
      const changed = pushed.items.find((i) => i.pageId === interviews())!;
      expect(changed.status).toBe('push-failed');
      expect(changed.message).toContain('changed in Confluence after the proposal');
      expect(pushed.items.find((i) => i.pageId === guide())?.status).toBe('pushed');
      expect(fake.writes.slice(before)).toEqual([guide()]);
    });
  });

  it('are checked without writing anything', async () => {
    await withApp(answer, async (app) => {
      const run = await staged(app);
      await decide(app, run.id, guide(), 'accept');
      const before = fake.writes.length;
      const checked = (await app.call<BranchRun>('POST', `/branches/runs/${run.id}/check`)).body;
      expect(checked.items.find((i) => i.pageId === guide())?.status).toBe('checked');
      expect(fake.writes.length).toBe(before);
    });
  });

  it('keep a decision made while edits are still arriving', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let edits = 0;
    const reply = async (payload: GuardedPayload): Promise<string> => {
      if (textOf(payload).includes('<<<PROPOSED_MARKDOWN>>>') && ++edits === 2) await held;
      return answer(payload);
    };
    await withApp(reply, async (app) => {
      const c = await directoryChat(app);
      const reviewed = await suggest(app, c.id);
      const { body: started } = await queue(app, c.id, reviewed.turns.length - 1, [0]);
      for (let run = started; run.items[0].status !== 'proposed';) {
        // eslint-disable-next-line no-await-in-loop -- waiting for the first edit
        await new Promise((resolve) => setTimeout(resolve, 10));
        // eslint-disable-next-line no-await-in-loop -- as above
        run = (await app.call<BranchRun>('GET', `/branches/runs/${started.id}`)).body;
      }
      await decide(app, started.id, interviews(), 'accept');
      release();
      const finished = await settled(app, started.id);
      expect(finished.items[0].status).toBe('accepted');
    });
  });

  it('let only an edit be decided on', async () => {
    await withApp(answer, async (app) => {
      const run = await staged(app);
      await decide(app, run.id, guide(), 'accept');
      await app.call('POST', `/branches/runs/${run.id}/push`);
      const late = await decide(app, run.id, guide(), 'reject');
      expect(late.status).toBe(409);
    });
  });
});
