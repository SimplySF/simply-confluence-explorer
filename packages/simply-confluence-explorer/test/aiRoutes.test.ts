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

// Asking an AI about pages and spaces. An excluded page must never be sent, by any route and in any
// form: not as the page asked about, not as a sub-page, not as space context and not as a title in
// the outline (ADR-018). Whatever is sent passes the outbound guard (ADR-022).

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectations } from '../../../test-env/fixtures/dataset.mjs';
import type { AnalyzeResponse, MetadataProgress, PageMetadata, SpaceTocNode, SyncProgress } from '../src/api/types.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp, type TestApp } from './support/testApp.js';

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(() => fake.close());

const withApp = async (run: (app: TestApp) => Promise<void>): Promise<void> => {
  const app = await startTestApp(fake);
  try {
    await run(app);
  } finally {
    await app.close();
  }
};

async function sync(app: TestApp, spaceKey: string): Promise<void> {
  const { body } = await app.call<SyncProgress>('POST', '/space-cache/sync', { spaceKey });
  for (let progress = body; ;) {
    if (progress.status !== 'pending' && progress.status !== 'running') return;
    // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
    await new Promise((resolve) => setTimeout(resolve, 20));
    // eslint-disable-next-line no-await-in-loop -- as above
    progress = (await app.call<SyncProgress>('GET', `/space-cache/sync/status/${body.jobId}`)).body;
  }
}

describe('an excluded page', () => {
  it('is refused on every route that sends a page to an AI, and nothing is sent', async () => {
    await withApp(async (app) => {
      const refusal = async (spaceKey: string, title: string): Promise<void> => {
        const id = fake.page(spaceKey, title).id;
        const analyze = await app.call('POST', '/ai/analyze', {
          pageId: id,
          spaceKey,
          prompt: 'Summarize',
          markdown: 'x',
        });
        expect(analyze.status, `analyze ${title}`).toBe(403);
        const summary = await app.call('POST', `/space-cache/${spaceKey}/pages/${id}/metadata/generate`, {});
        expect(summary.status, `summary of ${title}`).toBe(403);
        const scope = { scope: { kind: 'page', spaceKey, pageId: id } };
        const session = (await app.call<{ id: string }>('POST', '/ai/sessions', scope)).body;
        const turn = await app.call('POST', `/ai/sessions/${session.id}/messages`, { prompt: 'hi' });
        expect(turn.status, `conversation about ${title}`).toBe(403);
      };
      const all = Object.entries(expectations).flatMap(([key, expected]) =>
        expected.excluded.map((title) => [key, title] as const),
      );
      await Promise.all(all.map(([key, title]) => refusal(key, title)));
      expect(app.sent).toHaveLength(0);
    });
  });

  it("cannot be sent under a visible page's id: the server sends its own copy of the page it checked", async () => {
    await withApp(async (app) => {
      const visible = fake.page('PEOPLE', 'Benefits Overview');
      const excluded = fake.page('PEOPLE', 'Salary Bands');
      const res = await app.call('POST', '/ai/analyze', {
        pageId: visible.id,
        spaceKey: 'PEOPLE',
        prompt: 'Summarize',
        markdown: excluded.storage,
        pageTitle: 'Salary Bands',
      });
      expect(res.status).toBe(200);
      expect(app.sentText()).toContain('Health, dental, vision.');
      expect(app.sentText()).toContain('# Document Title: Benefits Overview');
      expect(app.sentText()).not.toContain('fake-range-a');
      expect(app.sentText()).not.toContain('Salary Bands');
    });
  });

  it('is left out of the sub-pages of a page that is asked about', async () => {
    await withApp(async (app) => {
      const home = fake.page('PLAT', 'Platform Engineering Home');
      const res = await app.call<AnalyzeResponse>('POST', '/ai/analyze', {
        pageId: home.id,
        spaceKey: 'PLAT',
        prompt: 'Summarize everything',
        markdown: '',
        includeChildren: true,
      });
      expect(res.status).toBe(200);
      expect(app.sentText()).toContain('Sub-Page: Architecture Overview');
      for (const title of expectations.PLAT.excluded) expect(app.sentText()).not.toContain(`Sub-Page: ${title}\n`);
    });
  });

  it('never appears in a space answer, as a page or as a title in the outline', async () => {
    await withApp(async (app) => {
      await sync(app, 'PEOPLE');
      const res = await app.call<AnalyzeResponse>('POST', '/space-cache/PEOPLE/ai/ask', {
        prompt: `${expectations.PEOPLE.excluded.join(' ')} policies`,
      });
      expect(res.status).toBe(200);
      expect(app.sentText()).toContain('Remote Work Policy');
      // The question names the excluded pages, so what is checked is the context, not the question.
      for (const title of expectations.PEOPLE.excluded) {
        expect(app.sentText()).not.toContain(`[Document: ${title}]`);
        expect(app.sentText()).not.toContain(`**${title}**`);
      }
    });
  });
});

describe('the outbound guard, on the dataset pages written to test it', () => {
  it('refuses a page holding a secret, naming the kind of secret but never the value', async () => {
    await withApp(async (app) => {
      const page = fake.page('OPS', 'Deploy Notes');
      const res = await app.call<{ error: string; findings: Array<{ type: string }> }>('POST', '/ai/analyze', {
        pageId: page.id,
        spaceKey: 'OPS',
        prompt: 'Summarize',
        markdown: page.storage,
      });
      expect(res.status).toBe(422);
      expect(res.body.findings.map((f) => f.type)).toContain(expectations.OPS.guard!.blocked['Deploy Notes']);
      expect(res.body.error).not.toContain('IOSFODNN7');
      expect(app.sent).toHaveLength(0);
    });
  });

  it('replaces personal data before sending, and puts it back in the answer', async () => {
    await withApp(async (app) => {
      const page = fake.page('OPS', 'Team Contacts');
      const res = await app.call<AnalyzeResponse>('POST', '/ai/analyze', {
        pageId: page.id,
        spaceKey: 'OPS',
        prompt: 'Who do I call?',
        markdown: page.storage,
      });
      expect(res.status).toBe(200);
      for (const value of expectations.OPS.guard!.redacted['Team Contacts']) {
        expect(app.sentText()).not.toContain(value);
        expect(res.body.answer).toContain(value);
      }
      expect(res.body.guard.summary).toMatch(/email address/);
    });
  });

  it('leaves a page holding a secret out of a space answer and names it, instead of refusing the question', async () => {
    await withApp(async (app) => {
      await sync(app, 'OPS');
      const res = await app.call<AnalyzeResponse>('POST', '/space-cache/OPS/ai/ask', { prompt: 'deploy notes role' });
      expect(res.status).toBe(200);
      expect(res.body.guard.summary).toContain('Left out because they contain a secret: Deploy Notes');
      expect(app.sentText()).not.toContain('IOSFODNN7');
    });
  });

  it('saves a space rule only when it parses, and then applies it', async () => {
    await withApp(async (app) => {
      expect((await app.call('POST', '/space-cache/OPS/guard', { text: 'block: ([unclosed' })).status).toBe(400);
      expect(
        (await app.call('POST', '/space-cache/OPS/guard', { text: 'block: duplicate title as fixture-phrase' })).status,
      ).toBe(200);
      const page = fake.page('OPS', 'Database Failover');
      const res = await app.call('POST', '/ai/analyze', {
        pageId: page.id,
        spaceKey: 'OPS',
        prompt: 'Summarize',
        markdown: page.storage,
      });
      expect(res.status).toBe(422);
    });
  });

  it('records each request in the audit log without its content', async () => {
    await withApp(async (app) => {
      const page = fake.page('OPS', 'Team Contacts');
      await app.call('POST', '/ai/analyze', {
        pageId: page.id,
        spaceKey: 'OPS',
        prompt: 'Who?',
        markdown: page.storage,
      });
      const log = fs.readFileSync(path.join(app.dataDir, 'data', 'ai-audit.jsonl'), 'utf8');
      expect(log).toContain('"outcome":"sent"');
      expect(log).toContain('"spaceKey":"OPS"');
      expect(log).not.toContain('Sam Rivera');
      expect(log).not.toContain('sam.rivera@example.com');
    });
  });
});

describe('AI summaries', () => {
  it('are generated for every visible synced page, and show up in the table of contents', async () => {
    await withApp(async (app) => {
      await sync(app, 'PEOPLE');
      const { body: started } = await app.call<MetadataProgress>('POST', '/space-cache/PEOPLE/metadata/generate', {});
      let progress = started;
      while (progress.status === 'pending' || progress.status === 'running') {
        // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
        await new Promise((resolve) => setTimeout(resolve, 20));
        // eslint-disable-next-line no-await-in-loop -- as above
        progress = (await app.call<MetadataProgress>('GET', `/space-cache/metadata/status/${started.jobId}`)).body;
      }
      expect(progress.status).toBe('completed');
      expect(progress.errorCount).toBe(0);
      const page = fake.page('PEOPLE', 'Benefits Overview');
      const meta = (await app.call<{ metadata: PageMetadata }>('GET', `/space-cache/PEOPLE/pages/${page.id}/metadata`))
        .body.metadata;
      expect(meta.summary).toBe('A page about operations.');
      const toc = (await app.call<{ toc: SpaceTocNode[] }>('GET', '/space-cache/PEOPLE/toc')).body.toc;
      expect(JSON.stringify(toc)).toContain('A page about operations.');
      for (const title of expectations.PEOPLE.excluded) expect(app.sentText()).not.toContain(title);
    });
  });
});

describe('a second request for AI summaries', () => {
  it('gets the run already going instead of summarising every page twice', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const app = await startTestApp(fake, async () => {
      await held;
      return '{"summary":"A page about operations.","tags":["ops"],"documentType":"runbook","systemsMentioned":[]}';
    });
    try {
      await sync(app, 'PEOPLE');
      const route = '/space-cache/PEOPLE/metadata/generate';
      const first = (await app.call<MetadataProgress>('POST', route, {})).body;
      const again = (await app.call<MetadataProgress>('POST', route, {})).body;
      expect(again.jobId).toBe(first.jobId);
      const section = await app.call<{ error: string }>('POST', route, {
        rootPageId: fake.page('PEOPLE', 'Benefits Overview').id,
      });
      expect(section.status).toBe(409);
      expect(section.body.error).toContain('already running for all of PEOPLE');
      release();
      let progress = first;
      while (progress.status === 'pending' || progress.status === 'running') {
        // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
        await new Promise((resolve) => setTimeout(resolve, 20));
        // eslint-disable-next-line no-await-in-loop -- as above
        progress = (await app.call<MetadataProgress>('GET', `/space-cache/metadata/status/${first.jobId}`)).body;
      }
      expect(progress.status).toBe('completed');
      expect(app.sent.length).toBe(progress.total);
    } finally {
      await app.close();
    }
  });
});

describe('text with no page named', () => {
  it('is sent as given, through the guard, for snippets and drafts that are not a page yet', async () => {
    await withApp(async (app) => {
      const res = await app.call<AnalyzeResponse>('POST', '/ai/analyze', {
        prompt: 'Explain',
        markdown: 'A pasted snippet for jane.doe@example.com.',
      });
      expect(res.status).toBe(200);
      expect(app.sentText()).toContain('A pasted snippet for [EMAIL-1].');
    });
  });
});

describe('the AI status', () => {
  it('names the configured engine', async () => {
    await withApp(async (app) => {
      expect((await app.call('GET', '/ai/status')).body).toEqual({
        available: true,
        engine: 'Claude (claude-opus-5-5)',
      });
    });
  });
});

describe('AI summaries for chosen pages', () => {
  it('summarise only those pages, and say how many of them had one', async () => {
    await withApp(async (app) => {
      await sync(app, 'PEOPLE');
      const ids = [fake.page('PEOPLE', 'Travel Policy').id, fake.page('PEOPLE', 'Remote Work Policy').id];
      const coverage = (body: unknown): Promise<{ body: { pages: number; missing: number } }> =>
        app.call('POST', '/space-cache/PEOPLE/metadata/coverage', body);
      expect((await coverage({ pageIds: ids })).body).toEqual({ pages: 2, missing: 2 });
      const { body: started } = await app.call<MetadataProgress>('POST', '/space-cache/PEOPLE/metadata/generate', {
        pageIds: ids,
      });
      let progress = started;
      while (progress.status === 'pending' || progress.status === 'running') {
        // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
        await new Promise((resolve) => setTimeout(resolve, 20));
        // eslint-disable-next-line no-await-in-loop -- as above
        progress = (await app.call<MetadataProgress>('GET', `/space-cache/metadata/status/${started.jobId}`)).body;
      }
      expect(progress.total).toBe(2);
      expect(app.sent).toHaveLength(2);
      expect((await coverage({ pageIds: ids })).body).toEqual({ pages: 2, missing: 0 });
      const whole = (await coverage({})).body;
      expect(whole.missing).toBe(whole.pages - 2);
      const salary = fake.page('PEOPLE', 'Salary Bands').id;
      expect((await coverage({ pageIds: [salary] })).body).toEqual({ pages: 0, missing: 0 });
      expect((await app.call('POST', '/space-cache/PEOPLE/metadata/coverage', { pageIds: ['../x'] })).status).toBe(400);
      // A directory counts with every page under it, as a chat on it reads them.
      const policies = fake.page('PEOPLE', 'Policies').id;
      expect((await coverage({ dirs: [policies] })).body).toEqual({ pages: 3, missing: 1 });
    });
  });
});
