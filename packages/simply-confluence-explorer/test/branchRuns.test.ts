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

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSessionView, BranchFinding, BranchItem, BranchRun } from '../src/api/types.js';
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

let edits = 0;
/**
 * Answers a request for suggestions with FINDINGS, an edit with a proposal for its page, and anything
 * else in words. Each edit differs from the last, because the pages are shared by every test and an
 * edit identical to its page changes nothing.
 */
const answer = (payload: GuardedPayload): string => {
  const text = textOf(payload);
  if (text.includes('<<<PROPOSED_MARKDOWN>>>')) {
    const title = /^# Document Title: (.+)$/m.exec(text)?.[1] ?? 'Page';
    return `<<<CRITIQUE>>>\n- None\n<<<CHANGELOG>>>\n- Applied\n<<<PROPOSED_MARKDOWN>>>\n# ${title}\n\nImproved body ${++edits}.`;
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
const chatOf = async (app: TestApp, id: string): Promise<AiSessionView> =>
  (await app.call<AiSessionView>('GET', `/ai/sessions/${id}`)).body;
/** Makes edits from the chat's suggestions at these places in its queue. */
const recommend = async (app: TestApp, id: string, picks: number[]): Promise<{ status: number; body: BranchRun }> => {
  const ids = (await chatOf(app, id)).suggestions?.map((s) => s.id) ?? [];
  return app.call<BranchRun>('POST', `/ai/sessions/${id}/suggestions/recommend`, { ids: picks.map((i) => ids[i]) });
};
/** A directory chat's review, then edits made from its first suggestion, which names both pages. */
const staged = async (app: TestApp, picks = [0]): Promise<BranchRun> => {
  const c = await directoryChat(app);
  await suggest(app, c.id);
  const res = await recommend(app, c.id, picks);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return settled(app, res.body.id);
};
/** Stages every page whose changes are decided with one accepted, as the Push tab offers them. */
const stageReady = async (app: TestApp, id: string): Promise<void> => {
  const run = (await app.call<BranchRun>('GET', `/branches/runs/${id}`)).body;
  for (const i of run.items.filter((x) => ['accepted', 'checked', 'push-failed'].includes(x.status)))
    // eslint-disable-next-line no-await-in-loop -- one page at a time, as the browser does
    await app.call('POST', `/branches/runs/${id}/items/${i.pageId}/stage`, { staged: true });
};
const push = async (app: TestApp, id: string): Promise<{ status: number; body: BranchRun }> => {
  await stageReady(app, id);
  return app.call<BranchRun>('POST', `/branches/runs/${id}/push`);
};
const check = async (app: TestApp, id: string): Promise<{ status: number; body: BranchRun }> => {
  await stageReady(app, id);
  return app.call<BranchRun>('POST', `/branches/runs/${id}/check`);
};
const decideAll = (
  app: TestApp,
  id: string,
  pageId: string,
  decision: string,
): Promise<{ status: number; body: BranchRun }> =>
  app.call<BranchRun>('POST', `/branches/runs/${id}/items/${pageId}/decide-all`, { decision });
const decideChange = (
  app: TestApp,
  id: string,
  pageId: string,
  changeId: string,
  decision: string,
): Promise<{ status: number; body: BranchRun }> =>
  app.call<BranchRun>('PATCH', `/branches/runs/${id}/items/${pageId}/changes/${changeId}`, { decision });
const setText = (
  app: TestApp,
  id: string,
  pageId: string,
  text: string,
): Promise<{ status: number; body: BranchRun }> =>
  app.call<BranchRun>('PUT', `/branches/runs/${id}/items/${pageId}/text`, { text });
const itemOf = (run: BranchRun, pageId: string): BranchItem => run.items.find((i) => i.pageId === pageId)!;

describe('suggestions in a chat', () => {
  it('are stored with the answer, with the pages it read, and never from an excluded page', async () => {
    await withApp(answer, async (app) => {
      const c = await directoryChat(app);
      const reviewed = await suggest(app, c.id);
      const turn = reviewed.turns.at(-1)!;
      expect(reviewed.turns.at(-2)?.text).toBe('Review these pages for problems');
      expect(
        reviewed.suggestions?.map(({ kind, pages, detail, suggestion }) => ({ kind, pages, detail, suggestion })),
      ).toEqual(FINDINGS);
      expect(reviewed.suggestions?.[0].pageIds).toEqual({ Interviews: interviews(), 'Interview Guide': guide() });
      expect(turn.text).toBe('3 suggestions added to the review queue.');
      expect(turn.queued).toEqual({ added: 3, updated: 0, removed: 0 });
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
      expect(changed.suggestions?.map((f) => f.detail)).toEqual(FINDINGS.map((f) => f.detail));
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
        expect(reviewed.suggestions ?? []).toEqual([]);
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
      const sentBefore = app.sent.length;
      const res = await recommend(app, c.id, [1]);
      const run = await settled(app, res.body.id);
      expect(run.kind).toBe('improve');
      expect(run.fromSessionId).toBe(c.id);
      expect(run.items.map((i) => i.title)).toEqual(['Interview Guide']);
      expect(run.items[0].fixes).toEqual([
        {
          kind: 'clarity',
          detail: 'The opening is vague',
          suggestion: 'Say who it is for',
          otherPages: [],
          suggestionId: reviewed.suggestions?.[1].id,
          seenVersion: fake.page('PEOPLE', 'Interview Guide').version,
        },
      ]);
      expect(run.items[0].baseVersion).toBe(fake.page('PEOPLE', 'Interview Guide').version);
      const sent = app.sent.slice(sentBefore).map(textOf).join('\n');
      expect(sent).toContain('The opening is vague');
      expect(sent).not.toContain('Both describe the loop');
      expect((await chatOf(app, c.id)).runIds).toEqual([run.id]);
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
      const ask = (ids: unknown): Promise<{ status: number }> =>
        app.call('POST', `/ai/sessions/${c.id}/suggestions/recommend`, { ids });
      const [, clarity, gap] = reviewed.suggestions!.map((s) => s.id);
      expect((await ask(['ffffffffffff'])).status).toBe(404);
      expect((await ask([])).status).toBe(400);
      expect((await ask([clarity, gap])).status).toBe(400);
      expect((await ask(['0'])).status).toBe(400);
      const other = await directoryChat(app);
      expect(
        (await app.call('POST', `/ai/sessions/${other.id}/suggestions/recommend`, { ids: [clarity] })).status,
      ).toBe(404);
    });
  });

  it('leaves out a page excluded after the suggestion was made', async () => {
    await withApp(answer, async (app) => {
      const c = await directoryChat(app);
      await suggest(app, c.id);
      await app.call('POST', '/space-cache/PEOPLE/ignore', {
        patterns: [`id:${guide()}`, 'id:{{id:Salary Bands}}', 'Interviews/Internal/'],
        purge: false,
      });
      const res = await recommend(app, c.id, [0]);
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
      await suggest(app, c.id);
      const res = await recommend(app, c.id, [0]);
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
      expect(run.items.every((i) => i.status === 'proposed' && i.proposed?.includes('Improved body'))).toBe(true);
      const before = fake.writes.length;

      await setText(app, run.id, guide(), '# Interview Guide\n\nEdited by a person.');
      await decideAll(app, run.id, guide(), 'accept');
      await decideAll(app, run.id, interviews(), 'reject');
      const pushed = (await push(app, run.id)).body;

      expect(fake.writes.slice(before)).toEqual([guide()]);
      expect(fake.page('PEOPLE', 'Interview Guide').storage).toContain('Edited by a person.');
      expect(pushed.items.find((i) => i.pageId === guide())?.status).toBe('pushed');
      expect(pushed.items.find((i) => i.pageId === interviews())?.status).toBe('rejected');
    });
  });

  it('refuse a page that changed after its edit was made, and still write the others', async () => {
    await withApp(answer, async (app) => {
      const run = await staged(app);
      await decideAll(app, run.id, interviews(), 'accept');
      await decideAll(app, run.id, guide(), 'accept');
      fake.page('PEOPLE', 'Interviews').version++;
      const before = fake.writes.length;
      const pushed = (await push(app, run.id)).body;
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
      await decideAll(app, run.id, guide(), 'accept');
      const before = fake.writes.length;
      const checked = (await check(app, run.id)).body;
      expect(checked.items.find((i) => i.pageId === guide())?.status).toBe('checked');
      expect(fake.writes.length).toBe(before);
    });
  });

  it('keep a decision made while edits are still arriving', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let proposals = 0;
    const reply = async (payload: GuardedPayload): Promise<string> => {
      if (textOf(payload).includes('<<<PROPOSED_MARKDOWN>>>') && ++proposals === 2) await held;
      return answer(payload);
    };
    await withApp(reply, async (app) => {
      const c = await directoryChat(app);
      await suggest(app, c.id);
      const { body: started } = await recommend(app, c.id, [0]);
      for (let run = started; run.items[0].status !== 'proposed';) {
        // eslint-disable-next-line no-await-in-loop -- waiting for the first edit
        await new Promise((resolve) => setTimeout(resolve, 10));
        // eslint-disable-next-line no-await-in-loop -- as above
        run = (await app.call<BranchRun>('GET', `/branches/runs/${started.id}`)).body;
      }
      await decideAll(app, started.id, interviews(), 'accept');
      release();
      const finished = await settled(app, started.id);
      expect(finished.items[0].status).toBe('accepted');
    });
  });

  it('let only an edit be decided on', async () => {
    await withApp(answer, async (app) => {
      const run = await staged(app);
      await decideAll(app, run.id, guide(), 'accept');
      await push(app, run.id);
      const late = await decideAll(app, run.id, guide(), 'reject');
      expect(late.status).toBe(409);
    });
  });
});

describe('the changes of one page', () => {
  /** The Interview Guide with a toc and two paragraphs, while `body` runs. */
  async function withRichGuide(body: () => Promise<void>): Promise<void> {
    const page = fake.page('PEOPLE', 'Interview Guide');
    const saved = page.storage;
    page.storage = `${TOC}<p>First paragraph.</p><p>Second paragraph.</p>`;
    try {
      await body();
    } finally {
      page.storage = saved;
    }
  }
  const TOC =
    '<ac:structured-macro ac:name="toc" ac:schema-version="1"><ac:parameter ac:name="maxLevel">2</ac:parameter></ac:structured-macro>';
  /** Rewrites both paragraphs, keeping the toc's marker, as the prompt asks. */
  const rewrite = (payload: GuardedPayload): string => {
    const text = textOf(payload);
    if (text.includes('<<<PROPOSED_MARKDOWN>>>') && text.includes('First paragraph.'))
      return '<<<CRITIQUE>>>\n- None\n<<<CHANGELOG>>>\n- Both\n<<<PROPOSED_MARKDOWN>>>\n⟦1 toc⟧\n\nFirst, reworded.\n\nSecond, reworded.';
    return answer(payload);
  };
  const stagedGuide = async (app: TestApp): Promise<BranchRun> => staged(app, [1]);

  it('are decided one by one, and a push writes only the accepted one, with the toc macro unchanged', async () => {
    await withRichGuide(() =>
      withApp(rewrite, async (app) => {
        const run = await stagedGuide(app);
        const item = itemOf(run, guide());
        expect(item.original).toContain('⟦1 toc⟧');
        expect(item.changes?.map((c) => [c.before, c.after, c.source])).toEqual([
          ['First paragraph.', 'First, reworded.', 'ai'],
          ['Second paragraph.', 'Second, reworded.', 'ai'],
        ]);
        const [first, second] = item.changes!;
        await decideChange(app, run.id, guide(), first.id, 'accept');
        const decided = (await decideChange(app, run.id, guide(), second.id, 'reject')).body;
        expect(itemOf(decided, guide()).status).toBe('accepted');
        expect(itemOf(decided, guide()).result).toBe('⟦1 toc⟧\n\nFirst, reworded.\n\nSecond paragraph.');
        await push(app, run.id);
        expect(fake.page('PEOPLE', 'Interview Guide').storage).toBe(
          `${TOC}<p>First, reworded.</p><p>Second paragraph.</p>`,
        );
      }),
    );
  });

  it("keep a decision when the person edits elsewhere, ask again about a change they edit, and reset to the AI's edit", async () => {
    await withRichGuide(() =>
      withApp(rewrite, async (app) => {
        const run = await stagedGuide(app);
        const [first] = itemOf(run, guide()).changes!;
        await decideChange(app, run.id, guide(), first.id, 'accept');
        const edited = (await setText(app, run.id, guide(), '⟦1 toc⟧\n\nFirst, reworded.\n\nSecond, my own way.')).body;
        expect(itemOf(edited, guide()).changes?.map((c) => [c.after, c.source, c.decision])).toEqual([
          ['First, reworded.', 'ai', 'accepted'],
          ['Second, my own way.', 'yours', 'pending'],
        ]);
        const reset = (await app.call<BranchRun>('POST', `/branches/runs/${run.id}/items/${guide()}/reset`)).body;
        const item = itemOf(reset, guide());
        expect(item.proposed).toBe(item.suggested);
        expect(item.changes?.every((c) => c.decision === 'pending' && c.source === 'ai')).toBe(true);
      }),
    );
  });

  it("name a change that removes the page's toc, and write the removal only once it is accepted", async () => {
    await withRichGuide(() =>
      withApp(rewrite, async (app) => {
        const run = await stagedGuide(app);
        const edited = (await setText(app, run.id, guide(), 'First, reworded.\n\nSecond, reworded.')).body;
        const removal = itemOf(edited, guide()).changes!.find((c) => c.before === '⟦1 toc⟧')!;
        expect(removal.notes).toEqual(['Removes ⟦1 toc⟧ from the page']);
        await decideAll(app, run.id, guide(), 'accept');
        await decideChange(app, run.id, guide(), removal.id, 'reject');
        await push(app, run.id);
        expect(fake.page('PEOPLE', 'Interview Guide').storage).toBe(
          `${TOC}<p>First, reworded.</p><p>Second, reworded.</p>`,
        );
      }),
    );
  });

  it("keep the text a person saved and the AI's edit beside it, so leaving the editor never loses their edits", async () => {
    await withRichGuide(() =>
      withApp(rewrite, async (app) => {
        const run = await stagedGuide(app);
        await setText(app, run.id, guide(), '⟦1 toc⟧\n\nMine.\n\nSecond, reworded.');
        const read = itemOf((await app.call<BranchRun>('GET', `/branches/runs/${run.id}`)).body, guide());
        expect(read.proposed).toBe('⟦1 toc⟧\n\nMine.\n\nSecond, reworded.');
        expect(read.suggested).toBe('⟦1 toc⟧\n\nFirst, reworded.\n\nSecond, reworded.');
      }),
    );
  });

  it('name a page that fails the check, with why, and check it again once it is fixed', async () => {
    await withRichGuide(() =>
      withApp(rewrite, async (app) => {
        const run = await stagedGuide(app);
        await setText(app, run.id, guide(), '⟦1 toc⟧\n\nFirst, reworded.\n\n```\nunclosed');
        await decideAll(app, run.id, guide(), 'accept');
        const failed = itemOf((await check(app, run.id)).body, guide());
        expect(failed.status).toBe('check-failed');
        expect(failed.message).toMatch(/^The dry run found a problem: Line \d+/);
        await setText(app, run.id, guide(), '⟦1 toc⟧\n\nFirst, reworded.\n\nSecond, reworded.');
        await decideAll(app, run.id, guide(), 'accept');
        const checked = itemOf((await check(app, run.id)).body, guide());
        expect(checked.status).toBe('checked');
      }),
    );
  });

  it('refuse to write an accepted change that puts a part inside code, where it would be lost', async () => {
    await withRichGuide(() =>
      withApp(rewrite, async (app) => {
        const run = await stagedGuide(app);
        await setText(app, run.id, guide(), '```\n⟦1 toc⟧\n```\n\nFirst, reworded.\n\nSecond, reworded.');
        await decideAll(app, run.id, guide(), 'accept');
        const before = fake.writes.length;
        const pushed = itemOf((await push(app, run.id)).body, guide());
        expect(pushed.status).toBe('push-failed');
        expect(pushed.message).toContain('no accepted change removes: ⟦1 toc⟧');
        expect(fake.writes.length).toBe(before);
      }),
    );
  });

  it('show a reworded paragraph and a new one after it as two changes, each decided on its own', async () => {
    await withRichGuide(() =>
      withApp(rewrite, async (app) => {
        const run = await stagedGuide(app);
        const text = '⟦1 toc⟧\n\nFirst paragraph, reworded slightly.\n\nWhen to escalate.\n\nSecond paragraph.';
        const edited = itemOf((await setText(app, run.id, guide(), text)).body, guide());
        expect(edited.changes?.map((c) => [c.before, c.after])).toEqual([
          ['First paragraph.', 'First paragraph, reworded slightly.'],
          ['', 'When to escalate.'],
        ]);
        await decideChange(app, run.id, guide(), edited.changes![1].id, 'accept');
        const decided = itemOf(
          (await decideChange(app, run.id, guide(), edited.changes![0].id, 'reject')).body,
          guide(),
        );
        expect(decided.result).toBe('⟦1 toc⟧\n\nFirst paragraph.\n\nWhen to escalate.\n\nSecond paragraph.');
      }),
    );
  });

  it('refuse a change naming a part the page does not have', async () => {
    await withRichGuide(() =>
      withApp(rewrite, async (app) => {
        const run = await stagedGuide(app);
        const edited = (await setText(app, run.id, guide(), '⟦1 toc⟧\n\n⟦9 jira⟧ First.\n\nSecond paragraph.')).body;
        const invented = itemOf(edited, guide()).changes![0];
        expect(invented.problem).toContain('⟦9⟧ is not a part of this page');
        expect((await decideChange(app, run.id, guide(), invented.id, 'accept')).status).toBe(409);
      }),
    );
  });

  it('make an edit again from the current page after a colleague changed it', async () => {
    await withRichGuide(() =>
      withApp(rewrite, async (app) => {
        const run = await stagedGuide(app);
        await decideAll(app, run.id, guide(), 'accept');
        const page = fake.page('PEOPLE', 'Interview Guide');
        page.version++;
        const refused = (await push(app, run.id)).body;
        expect(itemOf(refused, guide()).status).toBe('push-failed');
        await app.call('POST', `/branches/runs/${run.id}/items/${guide()}/redo`);
        const again = itemOf(await settled(app, run.id), guide());
        expect(again.baseVersion).toBe(page.version);
        expect(again.status).toBe('proposed');
        expect(again.changes).toHaveLength(2);
      }),
    );
  });
});

describe("a page's own record, its id, version, author and the like", () => {
  const RECORD =
    '---\nid: "1"\ntitle: Interview Guide\nversion: 3\nupdatedAt: 2026-10-20\nbreadcrumbs:\n  - People\n---';
  /** An edit that echoes the title line and the record, as a model shown them might. */
  const echo = (payload: GuardedPayload): string =>
    textOf(payload).includes('<<<PROPOSED_MARKDOWN>>>')
      ? `<<<CRITIQUE>>>\n- None\n<<<CHANGELOG>>>\n- Said who it is for\n<<<PROPOSED_MARKDOWN>>>\n# Document Title: Interview Guide\n\n\`\`\`yaml\n${RECORD}\n\`\`\`\n\nFor interviewers. ${++edits}`
      : answer(payload);

  it('is not given to the model that writes an edit', async () => {
    const sent: string[] = [];
    await withApp(
      (payload) => {
        sent.push(textOf(payload));
        return answer(payload);
      },
      async (app) => {
        await staged(app, [1]);
        const edit = sent.find((t) => t.includes('<<<PROPOSED_MARKDOWN>>>'))!;
        expect(edit).not.toMatch(/^(version|updatedAt|confluenceUrl|breadcrumbs):/m);
      },
    );
  });

  it('is not written into the page when an edit echoes it', async () => {
    await withApp(echo, async (app) => {
      const run = await staged(app, [1]);
      const item = itemOf(run, guide());
      expect(item.proposed).toMatch(/^For interviewers\./);
      await decideAll(app, run.id, guide(), 'accept');
      await push(app, run.id);
      const storage = fake.page('PEOPLE', 'Interview Guide').storage;
      expect(storage).toContain('For interviewers.');
      expect(storage).not.toMatch(/updatedAt|breadcrumbs|Document Title/);
    });
  });

  it('cannot be accepted when a change writes it as a list', async () => {
    await withApp(answer, async (app) => {
      const run = await staged(app, [1]);
      const list = '- **id:** 1\n- **version:** 3\n- **updatedAt:** 2026-10-20\n- **confluenceUrl:** https://wiki';
      const edited = (await setText(app, run.id, guide(), `${list}\n\n${itemOf(run, guide()).proposed}`)).body;
      const added = itemOf(edited, guide()).changes!.find((c) => c.after.includes('updatedAt'))!;
      expect(added.problem).toContain("the app's record of the page");
      expect((await decideChange(app, run.id, guide(), added.id, 'accept')).status).toBe(409);
    });
  });
});

describe('a run the app stopped while it was writing edits', () => {
  it('does not stay running after a restart, and its unfinished page can be made again', async () => {
    await withApp(answer, async (app) => {
      const run = await staged(app, [1]);
      // As the file is left when the app stops while the page's edit is being written.
      const file = path.join(app.dataDir, 'data', 'branch-runs', `${run.id}.json`);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as BranchRun;
      saved.status = 'running';
      Object.assign(itemOf(saved, guide()), { status: 'working', proposed: undefined, changes: undefined });
      fs.writeFileSync(file, JSON.stringify(saved));
      const read = (await app.call<BranchRun>('GET', `/branches/runs/${run.id}`)).body;
      expect(read.status).toBe('ready');
      expect(itemOf(read, guide())).toMatchObject({
        status: 'failed',
        message: 'The app stopped while this edit was being written.',
      });
      await app.call('POST', `/branches/runs/${run.id}/items/${guide()}/redo`);
      expect(itemOf(await settled(app, run.id), guide()).status).toBe('proposed');
    });
  });
});
