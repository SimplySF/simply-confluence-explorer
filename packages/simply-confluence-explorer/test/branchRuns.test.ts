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

// Branch runs: a proposal for every page, and nothing written that a person did not accept, each
// write checked against the version its proposal was made from (ADR-024).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BranchRun } from '../src/api/types.js';
import type { GuardedPayload } from '../src/ai/guard.js';
import { parseFindings } from '../src/branches/branchRuns.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp, type TestApp } from './support/testApp.js';

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(() => fake.close());

const proposal = (payload: GuardedPayload): string => {
  const title = /^# Document Title: (.+)$/m.exec(payload.messages[0].content)?.[1] ?? 'Page';
  return `<<<CRITIQUE>>>\n- Too short\n<<<CHANGELOG>>>\n- Expanded\n<<<PROPOSED_MARKDOWN>>>\n# ${title}\n\nImproved body.`;
};

async function withApp(
  reply: (payload: GuardedPayload, n: number) => string | Promise<string>,
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
const start = async (app: TestApp, kind: 'improve' | 'review'): Promise<BranchRun> =>
  settled(
    app,
    (await app.call<BranchRun>('POST', '/branches/runs', { kind, spaceKey: 'PEOPLE', pageId: interviews() })).body.id,
  );
const decide = (
  app: TestApp,
  id: string,
  pageId: string,
  decision: string,
  proposed?: string,
): Promise<{ status: number; body: BranchRun }> =>
  app.call<BranchRun>('PATCH', `/branches/runs/${id}/items/${pageId}`, { decision, proposed });

describe('improving a branch', () => {
  it('proposes every visible page, leaves the excluded ones out, and writes only the page accepted', async () => {
    await withApp(proposal, async (app) => {
      const run = await start(app, 'improve');
      expect(run.items.map((i) => i.title)).toEqual(['Interviews', 'Interview Guide']);
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

  it('refuses a page that changed after its proposal, and still writes the others', async () => {
    await withApp(proposal, async (app) => {
      const run = await start(app, 'improve');
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

  it('checks accepted pages without writing anything', async () => {
    await withApp(proposal, async (app) => {
      const run = await start(app, 'improve');
      await decide(app, run.id, guide(), 'accept');
      const before = fake.writes.length;
      const checked = (await app.call<BranchRun>('POST', `/branches/runs/${run.id}/check`)).body;
      expect(checked.items.find((i) => i.pageId === guide())?.status).toBe('checked');
      expect(fake.writes.length).toBe(before);
    });
  });

  it('keeps a decision made while proposals are still arriving', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const reply = async (payload: GuardedPayload, n: number): Promise<string> => {
      if (n === 2) await held;
      return proposal(payload);
    };
    await withApp(reply, async (app) => {
      const { body: started } = await app.call<BranchRun>('POST', '/branches/runs', {
        kind: 'improve',
        spaceKey: 'PEOPLE',
        pageId: interviews(),
      });
      for (let run = started; run.items[0].status !== 'proposed';) {
        // eslint-disable-next-line no-await-in-loop -- waiting for the first proposal
        await new Promise((resolve) => setTimeout(resolve, 10));
        // eslint-disable-next-line no-await-in-loop -- as above
        run = (await app.call<BranchRun>('GET', `/branches/runs/${started.id}`)).body;
      }
      await decide(app, started.id, interviews(), 'accept');
      release();
      const done = await settled(app, started.id);
      expect(done.items[0].status).toBe('accepted');
    });
  });

  it('lets only a proposal be decided on', async () => {
    await withApp(proposal, async (app) => {
      const run = await start(app, 'improve');
      await decide(app, run.id, guide(), 'accept');
      await app.call('POST', `/branches/runs/${run.id}/push`);
      const late = await decide(app, run.id, guide(), 'reject');
      expect(late.status).toBe(409);
    });
  });

  it('is refused for an excluded root page, and sends nothing', async () => {
    await withApp(proposal, async (app) => {
      const res = await app.call('POST', '/branches/runs', {
        kind: 'improve',
        spaceKey: 'PEOPLE',
        pageId: fake.page('PEOPLE', 'Salary Bands').id,
      });
      expect(res.status).toBe(403);
      expect(app.sent).toHaveLength(0);
    });
  });
});

describe('reviewing a branch', () => {
  it('reads findings from the answer, and records the id of every page it read', async () => {
    const findings = {
      findings: [
        {
          kind: 'redundant',
          pages: ['Interviews', 'Interview Guide'],
          detail: 'Both describe the loop',
          suggestion: 'Keep it in one page',
        },
      ],
    };
    await withApp(
      () => JSON.stringify(findings),
      async (app) => {
        const run = await start(app, 'review');
        expect(run.findings).toEqual(findings.findings);
        expect(run.pageIds).toEqual({ Interviews: interviews(), 'Interview Guide': guide() });
        expect(app.sentText()).not.toContain('Candidate Feedback');
      },
    );
  });

  it('keeps the answer as text when it is not findings, and drops a finding of an unknown kind', async () => {
    await withApp(
      () => 'Looks fine overall.',
      async (app) => {
        expect((await start(app, 'review')).reportText).toBe('Looks fine overall.');
      },
    );
    expect(parseFindings('{"findings":[{"kind":"made-up","detail":"x"}]}')).toEqual([]);
  });
});
