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

// A new page: the check for pages that already say it, the author's answer to it, and nothing
// created before that answer (ADR-025).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectations } from '../../../test-env/fixtures/dataset.mjs';
import type { AiSessionView, SyncProgress } from '../src/api/types.js';
import type { GuardedPayload } from '../src/ai/guard.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp, type TestApp } from './support/testApp.js';

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(() => fake.close());

// Judges every candidate's overlap as high, and answers a co-writing turn with a proposed draft.
const reply = (payload: GuardedPayload): string => {
  if (payload.system.includes('overlaps with the planned page')) {
    const ids = [...payload.messages[0].content.matchAll(/## Existing page (\d+):/g)].map((m) => m[1]);
    return JSON.stringify({ pages: ids.map((pageId) => ({ pageId, overlap: 'high', why: 'Covers the same steps.' })) });
  }
  return 'Here is an outline.\n<<<DRAFT>>>\n# Replica Promotion\n\n## Steps\n\n1. Check lag.\n<<<END DRAFT>>>';
};

async function withApp(run: (app: TestApp) => Promise<void>, env: NodeJS.ProcessEnv = {}): Promise<void> {
  const app = await startTestApp(fake, reply, env);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

const parent = (): string => fake.page('PLAT', 'Database Runbooks').id;
const start = (app: TestApp, title: string, notes = ''): Promise<{ status: number; body: AiSessionView }> =>
  app.call<AiSessionView>('POST', '/drafts', { spaceKey: 'PLAT', parentId: parent(), title, notes });

describe('the check for similar pages', () => {
  it('finds the existing page before a near-duplicate is written', async () => {
    await withApp(async (app) => {
      const { status, body } = await start(
        app,
        'Database Failover Procedure',
        'How to fail over the primary database and promote the replica',
      );
      expect(status).toBe(200);
      const similar = body.draft!.redundancy!.similar;
      expect(similar.map((p) => p.title)).toContain('Database Failover');
      expect(similar.find((p) => p.title === 'Database Failover')?.overlap).toBe('high');
    });
  });

  it('never offers an excluded page, even when the search finds it', async () => {
    await withApp(async (app) => {
      const { body } = await start(
        app,
        'Production Credentials Rotation',
        'Vendor contracts, the security audit, pen test findings and restricted access',
      );
      const offered = body.draft!.redundancy!.similar.map((p) => p.title);
      for (const title of expectations.PLAT.excluded) expect(offered).not.toContain(title);
      for (const title of expectations.PLAT.excluded) expect(app.sentText()).not.toContain(`: ${title}\n`);
    });
  });

  it('searches the synced copy as well as Confluence', async () => {
    await withApp(async (app) => {
      const started = (await app.call<SyncProgress>('POST', '/space-cache/sync', { spaceKey: 'PLAT' })).body;
      for (let p = started; p.status === 'pending' || p.status === 'running';) {
        // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
        await new Promise((resolve) => setTimeout(resolve, 20));
        // eslint-disable-next-line no-await-in-loop -- as above
        p = (await app.call<SyncProgress>('GET', `/space-cache/sync/status/${started.jobId}`)).body;
      }
      const { body } = await start(app, 'Database Failover Procedure', 'promote the replica');
      expect(body.draft!.redundancy!.similar.find((p) => p.title === 'Database Failover')?.source).toBe('synced');
    });
  });

  it('still runs without an AI, ranks by matching words, and says the overlap was not judged', async () => {
    await withApp(
      async (app) => {
        const { body } = await start(app, 'Database Failover Procedure', 'promote the replica');
        expect(body.draft!.redundancy!.similar.length).toBeGreaterThan(0);
        expect(body.draft!.redundancy!.note).toMatch(/No AI is set up/);
        expect(app.sent).toHaveLength(0);
      },
      { ANTHROPIC_API_KEY: '' },
    );
  });
});

describe('a draft', () => {
  it('is neither co-written nor created until the author answers the check', async () => {
    await withApp(async (app) => {
      const { body: d } = await start(app, 'Schema Migration Guide');
      expect((await app.call('POST', `/drafts/${d.id}/messages`, { prompt: 'Draft an outline' })).status).toBe(409);
      await app.call('PUT', `/drafts/${d.id}`, { markdown: '# Schema Migration Guide\n\nBody.' });
      const before = fake.writes.length;
      expect((await app.call('POST', `/drafts/${d.id}/create`)).status).toBe(409);
      expect((await app.call('POST', `/drafts/${d.id}/decision`, { decision: 'update-existing' })).status).toBe(200);
      const refused = await app.call<{ error: string }>('POST', `/drafts/${d.id}/create`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/update an existing page/);
      expect(fake.writes.length).toBe(before);
    });
  });

  it("keeps the co-writer's revision as a proposal, and creates the page the author saved, once", async () => {
    await withApp(async (app) => {
      const title = 'Replica Promotion';
      const { body: d } = await start(app, title, 'Cover lag checks');
      await app.call('POST', `/drafts/${d.id}/decision`, { decision: 'continue' });
      const { body } = await app.call<AiSessionView>('POST', `/drafts/${d.id}/messages`, {
        prompt: 'Draft an outline',
      });
      const answer = body.turns[1];
      expect(answer.proposedDraft).toContain('## Steps');
      expect(answer.text).not.toContain('<<<DRAFT>>>');
      expect(body.draft!.markdown, 'not applied until saved').toBe(`# ${title}\n\n`);

      await app.call('PUT', `/drafts/${d.id}`, { markdown: answer.proposedDraft });
      const done = await app.call<AiSessionView>('POST', `/drafts/${d.id}/create`);
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      const created = fake.pages.get(done.body.draft!.createdPageId!)!;
      expect(created.title).toBe(title);
      expect(created.ancestors.at(-1)?.id).toBe(parent());
      expect(created.storage).toContain('Check lag.');
      expect((await app.call('POST', `/drafts/${d.id}/create`)).status, 'and only once').toBe(409);
    });
  });

  it('is refused when its title is already used in the space, with the reason', async () => {
    await withApp(async (app) => {
      const { body: d } = await start(app, 'Database Failover');
      await app.call('POST', `/drafts/${d.id}/decision`, { decision: 'continue' });
      await app.call('PUT', `/drafts/${d.id}`, { markdown: '# Database Failover\n\nAgain.' });
      const res = await app.call<{ error: string }>('POST', `/drafts/${d.id}/create`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already exists in PLAT/);
    });
  });

  it('can be linked only to pages the check found', async () => {
    await withApp(async (app) => {
      const { body: d } = await start(app, 'Database Failover Procedure', 'promote the replica');
      expect(
        (await app.call('POST', `/drafts/${d.id}/decision`, { decision: 'link', linkedPageIds: ['999999'] })).status,
      ).toBe(400);
      const found = d.draft!.redundancy!.similar[0].pageId;
      expect(
        (await app.call('POST', `/drafts/${d.id}/decision`, { decision: 'link', linkedPageIds: [found] })).status,
      ).toBe(200);
    });
  });

  it('reports content Confluence would not accept before anything is created', async () => {
    await withApp(async (app) => {
      const { body: d } = await start(app, 'Broken Page');
      await app.call('POST', `/drafts/${d.id}/decision`, { decision: 'continue' });
      await app.call('PUT', `/drafts/${d.id}`, { markdown: '# Broken Page\n\n```bash\nunclosed fence' });
      const before = fake.writes.length;
      const res = await app.call<{ error: string }>('POST', `/drafts/${d.id}/check`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/^The dry run found a problem/);
      expect(fake.writes.length).toBe(before);
    });
  });

  it('cannot be written through the general conversation route', async () => {
    await withApp(async (app) => {
      const { body: d } = await start(app, 'Another Page');
      expect((await app.call('POST', `/ai/sessions/${d.id}/messages`, { prompt: 'hi' })).status).toBe(400);
    });
  });
});

describe('what the co-writer reads', () => {
  const ready = async (app: TestApp): Promise<string> => {
    const { body } = await start(app, 'Billing Service', 'The billing service and its API');
    await app.call('POST', `/drafts/${body.id}/decision`, { decision: 'continue' });
    return body.id;
  };

  it('follows an example page and a pasted structure, and refuses an excluded example', async () => {
    await withApp(async (app) => {
      const id = await ready(app);
      const example = fake.page('PLAT', 'Auth Service').id;
      const excluded = fake.page('PLAT', 'Production Credentials').id;
      expect((await app.call('PUT', `/drafts/${id}`, { examplePageId: excluded })).status).toBe(403);
      expect((await app.call('PUT', `/drafts/${id}`, { examplePageId: '../x' })).status).toBe(400);
      await app.call('PUT', `/drafts/${id}`, { examplePageId: example, template: '## Overview\n## Runbook' });
      await app.call('POST', `/drafts/${id}/messages`, { prompt: 'Draft it' });
      const sent = app.sentText();
      expect(sent).toContain('Example page whose structure to follow: Auth Service');
      expect(sent).toContain('## Structure to follow\n## Overview\n## Runbook');
      // An example excluded after it was chosen is no longer sent.
      const rules = await app.call<{ patterns: string[] }>('GET', '/space-cache/PLAT/ignore');
      await app.call('POST', '/space-cache/PLAT/ignore', {
        patterns: [...rules.body.patterns, `id:${example}`],
        purge: false,
      });
      const before = app.sent.length;
      await app.call('POST', `/drafts/${id}/messages`, { prompt: 'Again' });
      expect(
        app.sent
          .slice(before)
          .map((p) => p.messages.map((m) => m.content).join('\n'))
          .join('\n'),
      ).not.toContain('Example page whose structure to follow');
    });
  });

  it('reads a GitLab repository, through the guard, only once GitLab is set up', async () => {
    const { startFakeGitLab, GITLAB_PROJECT, GITLAB_TOKEN } = await import('./support/fakeGitLab.js');
    const gitlab = await startFakeGitLab();
    try {
      await withApp(async (app) => {
        const id = await ready(app);
        const link = `${gitlab.url}/${GITLAB_PROJECT}`;
        expect((await app.call('POST', `/drafts/${id}/repositories`, { link })).status).toBe(400);
        await app.call('PUT', '/gitlab', { baseUrl: gitlab.url, token: GITLAB_TOKEN });
        const added = await app.call<AiSessionView>('POST', `/drafts/${id}/repositories`, { link });
        expect(added.body.files.map((f) => f.name)).toEqual(['billing-service (GitLab).md']);
        await app.call('POST', `/drafts/${id}/messages`, { prompt: 'Draft it from the repository' });
        expect(app.sentText()).toContain('Charges customers each month.');
        expect(
          (await app.call('POST', `/drafts/${id}/repositories`, { link: 'https://evil.example.test/a/b' })).status,
        ).toBe(400);

        gitlab.files.set('README.md', `Deploy key: ${['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')}`);
        const second = await ready(app);
        await app.call('POST', `/drafts/${second}/repositories`, { link });
        const blocked = await app.call('POST', `/drafts/${second}/messages`, { prompt: 'Draft it' });
        expect(blocked.status).toBe(422);
      });
    } finally {
      await gitlab.close();
    }
  });
});

describe('a series of pages', () => {
  const seriesReply = (payload: GuardedPayload): string => {
    if (payload.system.includes('overlaps with the planned page')) return '{"pages":[]}';
    return [
      'Here is a series.',
      '<<<SERIES>>>',
      '<<<PAGE: Billing Service>>>',
      '# Billing Service\n\nAn overview.',
      '<<<PAGE: Billing API>>>',
      '# Billing API\n\nThe endpoints.',
      '<<<PAGE: Billing Operations>>>',
      '# Billing Operations\n\nHow to run it.',
      '<<<END SERIES>>>',
    ].join('\n');
  };

  it('is read from the co-writer, and its pages are checked for similar titles', async () => {
    const { parseSeries } = await import('../src/drafts/drafts.js');
    expect(
      parseSeries(seriesReply({ system: '', messages: [] } as unknown as GuardedPayload)).map((p) => p.title),
    ).toEqual(['Billing Service', 'Billing API', 'Billing Operations']);
    expect(parseSeries('No series here.')).toEqual([]);
    const app = await startTestApp(fake, seriesReply);
    try {
      const { body } = await start(app, 'Billing Service', 'The billing service');
      await app.call('POST', `/drafts/${body.id}/decision`, { decision: 'continue' });
      const answered = (await app.call<AiSessionView>('POST', `/drafts/${body.id}/messages`, { prompt: 'Draft it' }))
        .body;
      const series = answered.turns.at(-1)!.proposedSeries!;
      expect(series.map((p) => p.title)).toEqual(['Billing Service', 'Billing API', 'Billing Operations']);
      expect(answered.turns.at(-1)!.text).toContain('Proposed a series of 3 pages');
      const saved = await app.call<AiSessionView>('PUT', `/drafts/${body.id}`, {
        children: [{ title: 'Database Failover Notes', markdown: '# Notes\n\nText.' }],
      });
      expect(saved.body.draft!.children![0].similar!.map((s) => s.title)).toContain('Database Failover');
      const tooMany = Array.from({ length: 12 }, (_, i) => ({ title: `Page ${i}`, markdown: 'x' }));
      expect((await app.call('PUT', `/drafts/${body.id}`, { children: tooMany })).status).toBe(400);
      expect((await app.call('PUT', `/drafts/${body.id}`, { children: [{ title: ' ', markdown: 'x' }] })).status).toBe(
        400,
      );
    } finally {
      await app.close();
    }
  });

  it('is created overview first, children under it in order; a failure partway names what was created, and creating again finishes', async () => {
    await withApp(async (app) => {
      const { body } = await start(app, 'Replica Promotion Guide', 'Promoting a replica');
      await app.call('POST', `/drafts/${body.id}/decision`, { decision: 'continue' });
      await app.call('PUT', `/drafts/${body.id}`, {
        markdown: '# Replica Promotion Guide\n\nThe overview.',
        children: [
          { title: 'Replica Promotion Steps', markdown: '# Steps\n\n1. Check lag.' },
          // A title the space already has: Confluence refuses it when the page is created.
          { title: 'Database Failover', markdown: '# Checks\n\nAfter promotion.' },
        ],
      });
      const failed = await app.call<{ error: string }>('POST', `/drafts/${body.id}/create`);
      expect(failed.status).toBeGreaterThanOrEqual(400);
      expect(failed.body.error).toContain('Created Replica Promotion Guide, Replica Promotion Steps');
      expect(failed.body.error).toContain('“Database Failover” was not');
      const draft = (await app.call<AiSessionView>('GET', `/ai/sessions/${body.id}`)).body.draft!;
      const overview = fake.pages.get(draft.createdPageId!)!;
      expect(overview.ancestors.at(-1)?.id).toBe(parent());
      const steps = fake.pages.get(draft.children![0].createdPageId!)!;
      expect(steps.ancestors.at(-1)?.id).toBe(overview.id);
      expect((await app.call('PUT', `/drafts/${body.id}`, { markdown: 'changed' })).status).toBe(409);
      await app.call('PUT', `/drafts/${body.id}`, {
        children: [
          { title: 'Replica Promotion Steps', markdown: '# Steps\n\n1. Check lag.' },
          { title: 'Replica Promotion Checks', markdown: '# Checks\n\nAfter promotion.' },
        ],
      });
      const done = await app.call<AiSessionView>('POST', `/drafts/${body.id}/create`);
      expect(done.status).toBe(200);
      const children = done.body.draft!.children!;
      expect(children[0].createdPageId).toBe(steps.id);
      expect(fake.pages.get(children[1].createdPageId!)?.ancestors.at(-1)?.id).toBe(overview.id);
    });
  });
});
