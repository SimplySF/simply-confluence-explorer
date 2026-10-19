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

// Improving one page and writing it back. No page changes unless a person sent the push, a push
// made from a stale copy never replaces a colleague's edit, and the app's frontmatter never lands in
// Confluence.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PageResponse, SyncProgress, WriteResult } from '../src/api/types.js';
import { parseRecommendationResponse } from '../src/ai/improve.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp, type TestApp } from './support/testApp.js';

let fake: FakeConfluence;
let app: TestApp;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(() => fake.close());
beforeEach(async () => {
  app = await startTestApp(fake, (payload) =>
    payload.system.includes('<<<PROPOSED_MARKDOWN>>>') || payload.messages[0].content.includes('Document Title')
      ? '<<<CRITIQUE>>>\n- Thin\n<<<CHANGELOG>>>\n- Expanded\n<<<PROPOSED_MARKDOWN>>>\n# Better\n\nProposed body.'
      : 'answer',
  );
  return () => app.close();
});

const post = <T>(route: string, body: unknown): Promise<{ status: number; body: T }> =>
  app.call<T>('POST', route, body);

describe('a dry run', () => {
  it('converts the change and writes nothing', async () => {
    const page = fake.page('OPS', 'EMEA Rotation');
    const before = fake.writes.length;
    const res = await post<WriteResult>(`/pages/${page.id}/dry-run`, {
      markdown: '# EMEA Rotation\n\nWeekly.',
      baseVersion: page.version,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pageId: page.id, version: page.version, dryRun: true });
    expect(fake.writes.length).toBe(before);
  });

  it('reports content Confluence would not accept, naming the line', async () => {
    const page = fake.page('OPS', 'EMEA Rotation');
    const res = await post<{ error: string }>(`/pages/${page.id}/dry-run`, {
      markdown: 'Intro\n\n```bash\nunclosed fence',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^The dry run found a problem: Line \d+/);
  });
});

describe('a push', () => {
  it('needs the version the proposal was made from', async () => {
    const page = fake.page('OPS', 'EMEA Rotation');
    expect((await post(`/pages/${page.id}/push`, { markdown: '# x' })).status).toBe(400);
  });

  it('is refused for a page whose image would become placeholder text, and writes nothing', async () => {
    const page = fake.page('OPS', 'Capacity Planning');
    const before = fake.writes.length;
    const original = page.storage;
    const markdown = 'See attached CSV.\n\n[image: capacity-chart.png]\n\n## Who to ask\n\nThe owning team.';
    const dry = await post<{ error: string }>(`/pages/${page.id}/dry-run`, { markdown, baseVersion: page.version });
    expect(dry.status).toBe(400);
    expect(dry.body.error).toMatch(/^The dry run found a problem: this page has parts that Markdown cannot carry/);
    expect(dry.body.error).toContain('1 image');
    const push = await post<{ error: string }>(`/pages/${page.id}/push`, { markdown, baseVersion: page.version });
    expect(push.status).toBe(400);
    expect(push.body.error).toContain('Nothing was written');
    expect(fake.writes.length).toBe(before);
    expect(page.storage).toBe(original);
  });

  it('is refused for a page whose link to another page would become plain text', async () => {
    const page = fake.page('OPS', 'On-Call Handbook');
    const res = await post<{ error: string }>(`/pages/${page.id}/push`, {
      markdown: 'Start here. See [Database Failover].',
      baseVersion: page.version,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('1 link to another page');
  });

  it('is refused when the page changed after the proposal, and writes nothing', async () => {
    const page = fake.page('OPS', 'EMEA Rotation');
    const before = fake.writes.length;
    const stale = page.version;
    page.version++;
    const res = await post<{ error: string }>(`/pages/${page.id}/push`, { markdown: '# x', baseVersion: stale });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('changed in Confluence after the proposal was made');
    expect(fake.writes.length).toBe(before);
  });

  it('writes the change without the frontmatter, bumps the version, and refreshes the synced copy', async () => {
    const started = (await post<SyncProgress>('/space-cache/sync', { spaceKey: 'OPS' })).body;
    for (let p = started; p.status === 'pending' || p.status === 'running';) {
      // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
      await new Promise((resolve) => setTimeout(resolve, 20));
      // eslint-disable-next-line no-await-in-loop -- as above
      p = (await app.call<SyncProgress>('GET', `/space-cache/sync/status/${started.jobId}`)).body;
    }
    const page = fake.page('OPS', 'Database Failover');
    const markdown = `---\nid: "${page.id}"\ntitle: Database Failover\nversion: ${page.version}\n---\n\n# Database Failover\n\nPromote the **replica**.`;
    const res = await post<WriteResult>(`/pages/${page.id}/push`, {
      markdown,
      baseVersion: page.version,
      spaceKey: 'OPS',
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(page.version);
    expect(page.storage).toContain('<strong>replica</strong>');
    expect(page.storage).not.toContain('title: Database Failover');
    const local = await app.call<PageResponse>('GET', `/pages/${page.id}?spaceKey=OPS`);
    expect(local.body.isLocal).toBe(true);
    expect(local.body.detail.version).toBe(page.version);
    expect(local.body.parsed.markdown).toContain('Promote the **replica**.');
  });
});

describe('reading a proposal', () => {
  it('reads the delimited form the prompt asks for', () => {
    const r = parseRecommendationResponse(
      '<<<CRITIQUE>>>\n- a\n- b\n<<<CHANGELOG>>>\n* c\n<<<PROPOSED_MARKDOWN>>>\n```markdown\n# T\n```',
    );
    expect(r).toEqual({ critique: ['a', 'b'], changelog: ['c'], improvedMarkdown: '# T' });
  });

  it('still reads a model that answered in JSON, even broken JSON, or in bare Markdown', () => {
    expect(parseRecommendationResponse('{"critique":["x"],"changelog":"y","improvedMarkdown":"# J"}')).toEqual({
      critique: ['x'],
      changelog: ['y'],
      improvedMarkdown: '# J',
    });
    expect(parseRecommendationResponse('{"critique": ["a",], "improvedMarkdown": "# K\\nline"}').improvedMarkdown).toBe(
      '# K\nline',
    );
    expect(parseRecommendationResponse('# Bare\n\nText').improvedMarkdown).toBe('# Bare\n\nText');
  });
});
