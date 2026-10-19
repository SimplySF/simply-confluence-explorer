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

// Reviews of a set of pages, and the edits staged from the suggestions a person chose: nothing is
// written that a person did not accept, each write checked against the version its edit was made from
// (ADR-024, ADR-046).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BranchFinding, BranchRun } from '../src/api/types.js';
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

/** Answers a review with FINDINGS, and an edit with a proposal for the page it was sent. */
const answer = (payload: GuardedPayload): string => {
  const text = [payload.system, ...payload.messages.map((m) => m.content)].join('\n');
  if (text.includes('"findings"')) return JSON.stringify({ findings: FINDINGS });
  const title = /^# Document Title: (.+)$/m.exec(text)?.[1] ?? 'Page';
  return `<<<CRITIQUE>>>\n- None\n<<<CHANGELOG>>>\n- Applied\n<<<PROPOSED_MARKDOWN>>>\n# ${title}\n\nImproved body.`;
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
const section = (pageIds = [interviews(), guide()]): Record<string, unknown> => ({
  spaceKey: 'PEOPLE',
  source: { kind: 'section', rootPageId: interviews() },
  pageIds,
});
const review = async (app: TestApp, body = section()): Promise<BranchRun> =>
  settled(app, (await app.call<BranchRun>('POST', '/branches/runs', body)).body.id);
const apply = async (app: TestApp, reviewId: string, findings: number[]): Promise<BranchRun> => {
  const res = await app.call<BranchRun>('POST', `/branches/runs/${reviewId}/apply`, { findings });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return settled(app, res.body.id);
};
/** A review of the section, then edits staged from its first suggestion, which names both pages. */
const staged = async (app: TestApp): Promise<BranchRun> => apply(app, (await review(app)).id, [0]);
const decide = (
  app: TestApp,
  id: string,
  pageId: string,
  decision: string,
  proposed?: string,
): Promise<{ status: number; body: BranchRun }> =>
  app.call<BranchRun>('PATCH', `/branches/runs/${id}/items/${pageId}`, { decision, proposed });

describe('reviewing a section', () => {
  it('reads findings from the answer, records the id of every page it read, and never sends an excluded one', async () => {
    await withApp(answer, async (app) => {
      const run = await review(app);
      expect(run.findings).toEqual(FINDINGS);
      expect(run.pageIds).toEqual({ Interviews: interviews(), 'Interview Guide': guide() });
      expect(run.source).toEqual({ kind: 'section', rootPageId: interviews() });
      expect(app.sentText()).not.toContain('Candidate Feedback');
    });
  });

  it('reads only the pages the person ticked', async () => {
    await withApp(answer, async (app) => {
      const run = await review(app, section([interviews()]));
      expect(run.pageIds).toEqual({ Interviews: interviews() });
      expect(app.sentText()).not.toContain('Visible guide for interviewers.');
    });
  });

  it('asks only for what the person ticked, and their own notes', async () => {
    const prompt = reviewPrompt(['clarity', 'staleness'], 2, 'we moved to GitLab CI');
    expect(prompt).toContain('"clarity"');
    expect(prompt).toContain('"stale"');
    expect(prompt).not.toContain('"redundant"');
    expect(prompt).toContain('"placement"');
    expect(prompt).toContain('Also: we moved to GitLab CI');
    expect(reviewPrompt(['clarity'], 1)).not.toContain('"gap"');
    await withApp(answer, async (app) => {
      await review(app, { ...section(), aspects: ['depth'] });
      expect(app.sentText()).toContain('"depth"');
      expect(app.sentText()).not.toContain('"operations"');
    });
  });

  it('refuses a page outside the section, an excluded page, too many pages, and an unknown aspect, sending nothing', async () => {
    await withApp(answer, async (app) => {
      const outside = await app.call('POST', '/branches/runs', section([fake.page('PEOPLE', 'Benefits Overview').id]));
      expect(outside.status).toBe(400);
      const internal = fake.page('PEOPLE', 'Internal').id;
      const excluded = await app.call('POST', '/branches/runs', section([interviews(), internal]));
      expect(excluded.status).toBe(403);
      const many = await app.call('POST', '/branches/runs', section(Array.from({ length: 51 }, (_, i) => `${i + 1}`)));
      expect(many.status).toBe(400);
      expect((await app.call('POST', '/branches/runs', section(['../x']))).status).toBe(400);
      expect((await app.call('POST', '/branches/runs', { ...section(), aspects: ['tone'] })).status).toBe(400);
      expect(app.sent).toHaveLength(0);
    });
  });

  it('reviews one page on its own, and nothing but that page', async () => {
    await withApp(answer, async (app) => {
      const page = { spaceKey: 'PEOPLE', source: { kind: 'page', rootPageId: guide() } };
      const run = await review(app, { ...page, pageIds: [guide()] });
      expect(run.pageIds).toEqual({ 'Interview Guide': guide() });
      expect((await app.call('POST', '/branches/runs', { ...page, pageIds: [guide(), interviews()] })).status).toBe(
        400,
      );
      const elsewhere = fake.page('OPS', 'On-Call Handbook').id;
      const other = { spaceKey: 'PEOPLE', source: { kind: 'page', rootPageId: elsewhere }, pageIds: [elsewhere] };
      expect((await app.call('POST', '/branches/runs', other)).status).toBe(400);
    });
  });

  it('is refused for an excluded page, and sends nothing', async () => {
    await withApp(answer, async (app) => {
      const salary = fake.page('PEOPLE', 'Salary Bands').id;
      const res = await app.call('POST', '/branches/runs', {
        spaceKey: 'PEOPLE',
        source: { kind: 'page', rootPageId: salary },
        pageIds: [salary],
      });
      expect(res.status).toBe(403);
      expect(app.sent).toHaveLength(0);
    });
  });

  it('keeps the answer as text when it is not findings, and drops a finding of an unknown kind', async () => {
    await withApp(
      () => 'Looks fine overall.',
      async (app) => {
        expect((await review(app)).reportText).toBe('Looks fine overall.');
      },
    );
    expect(parseFindings('{"findings":[{"kind":"made-up","detail":"x"}]}')).toEqual([]);
  });

  it('stops at once when stopped before its answer arrives, ends the request, and keeps no findings', async () => {
    let aborted = false;
    let answered = (): void => undefined;
    const late = new Promise<void>((resolve) => (answered = resolve));
    const reply = async (payload: GuardedPayload, _n: number, signal?: AbortSignal): Promise<string> => {
      signal?.addEventListener('abort', () => (aborted = true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      answered();
      return answer(payload);
    };
    await withApp(reply, async (app) => {
      const { body: started } = await app.call<BranchRun>('POST', '/branches/runs', section());
      const stopped = (await app.call<BranchRun>('POST', `/branches/runs/${started.id}/cancel`)).body;
      expect(stopped.status).toBe('cancelled');
      await late;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const after = (await app.call<BranchRun>('GET', `/branches/runs/${started.id}`)).body;
      expect(after.status).toBe('cancelled');
      expect(after.findings).toBeUndefined();
      expect(aborted).toBe(true);
    });
  });
});

describe('applying suggestions', () => {
  it('stages an edit of each page the chosen suggestions name, carrying only those suggestions', async () => {
    await withApp(answer, async (app) => {
      const done = await review(app);
      const sentBefore = app.sent.length;
      const run = await apply(app, done.id, [1]);
      expect(run.kind).toBe('improve');
      expect(run.fromRunId).toBe(done.id);
      expect(run.items.map((i) => i.title)).toEqual(['Interview Guide']);
      expect(run.items[0].fixes).toEqual([
        { kind: 'clarity', detail: 'The opening is vague', suggestion: 'Say who it is for', otherPages: [] },
      ]);
      expect(run.items[0].baseVersion).toBe(fake.page('PEOPLE', 'Interview Guide').version);
      const sent = app.sent
        .slice(sentBefore)
        .map((p) => [p.system, ...p.messages.map((m) => m.content)].join('\n'))
        .join('\n');
      expect(sent).toContain('The opening is vague');
      expect(sent).not.toContain('Both describe the loop');
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

  it('refuses a suggestion that is not in the review, or that no edit can carry out', async () => {
    await withApp(answer, async (app) => {
      const done = await review(app);
      expect((await app.call('POST', `/branches/runs/${done.id}/apply`, { findings: [7] })).status).toBe(400);
      expect((await app.call('POST', `/branches/runs/${done.id}/apply`, { findings: [] })).status).toBe(400);
      expect((await app.call('POST', `/branches/runs/${done.id}/apply`, { findings: [1, 2] })).status).toBe(400);
      expect((await app.call('POST', `/branches/runs/${done.id}/apply`, { findings: ['0'] })).status).toBe(400);
    });
  });

  it('leaves out a page excluded after the review was made', async () => {
    await withApp(answer, async (app) => {
      const done = await review(app);
      await app.call('POST', '/space-cache/PEOPLE/ignore', {
        patterns: [`id:${guide()}`, 'id:{{id:Salary Bands}}', 'Interviews/Internal/'],
        purge: false,
      });
      const run = await apply(app, done.id, [0]);
      expect(run.items.map((i) => i.title)).toEqual(['Interviews']);
    });
  });
});

describe('the staged edits', () => {
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
      const text = answer(payload);
      if (!text.startsWith('{') && ++edits === 2) await held;
      return text;
    };
    await withApp(reply, async (app) => {
      const done = await review(app);
      const { body: started } = await app.call<BranchRun>('POST', `/branches/runs/${done.id}/apply`, { findings: [0] });
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

describe('earlier runs', () => {
  it('are listed for the section or page they were made on, and a run saved before sources is a section', async () => {
    await withApp(answer, async (app) => {
      await review(app);
      await review(app, {
        spaceKey: 'PEOPLE',
        source: { kind: 'page', rootPageId: interviews() },
        pageIds: [interviews()],
      });
      const list = async (source: string): Promise<number> =>
        (
          await app.call<{ runs: unknown[] }>(
            'GET',
            `/branches/runs?${new URLSearchParams({ spaceKey: 'PEOPLE', source, pageId: interviews() }).toString()}`,
          )
        ).body.runs.length;
      expect(await list('section')).toBe(1);
      expect(await list('page')).toBe(1);
    });
  });
});

describe('reviewing the pages that carry a tag', () => {
  const syncPeople = async (app: TestApp): Promise<void> => {
    const { body } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey: 'PEOPLE' });
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
      const { body: p } = await app.call<{ status: string }>('GET', `/space-cache/sync/status/${body.jobId}`);
      if (p.status !== 'running' && p.status !== 'pending') return;
      // eslint-disable-next-line no-await-in-loop -- as above
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const tagged = (pageIds: string[]): Record<string, unknown> => ({
    spaceKey: 'PEOPLE',
    source: { kind: 'tag', tag: 'Policy' },
    pageIds,
  });

  it('reads the tagged pages wherever they sit, and is listed under its tag', async () => {
    await withApp(answer, async (app) => {
      await syncPeople(app);
      const remote = fake.page('PEOPLE', 'Remote Work Policy').id;
      const travel = fake.page('PEOPLE', 'Travel Policy').id;
      const run = await review(app, tagged([remote, travel]));
      expect(run.status).toBe('ready');
      expect(run.rootTitle).toBe('#policy');
      expect(run.pageIds).toEqual({ 'Remote Work Policy': remote, 'Travel Policy': travel });
      const listed = await app.call<{ runs: unknown[] }>('GET', '/branches/runs?spaceKey=PEOPLE&source=tag&tag=policy');
      expect(listed.body.runs).toHaveLength(1);
    });
  });

  it('refuses a page without the tag, and an excluded page that once carried another, sending nothing', async () => {
    await withApp(answer, async (app) => {
      await syncPeople(app);
      const benefits = fake.page('PEOPLE', 'Benefits Overview').id;
      expect((await app.call('POST', '/branches/runs', tagged([benefits]))).status).toBe(400);
      const salary = fake.page('PEOPLE', 'Salary Bands').id;
      const compensation = { ...tagged([salary]), source: { kind: 'tag', tag: 'compensation' } };
      expect((await app.call('POST', '/branches/runs', compensation)).status).toBe(400);
      expect(
        (await app.call('POST', '/branches/runs', { ...tagged([benefits]), source: { kind: 'tag' } })).status,
      ).toBe(400);
      expect(app.sent).toHaveLength(0);
    });
  });
});
