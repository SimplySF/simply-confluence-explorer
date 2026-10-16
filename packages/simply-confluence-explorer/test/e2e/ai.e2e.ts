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

// Asking an AI about the real Confluence Data Center test environment. The AI is a recorder, so the
// tests see exactly what would have left the machine after the outbound guard: no excluded page on
// any route, no secret, and no personal data (ADR-018, ADR-022).

import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSessionView, AnalyzeResponse, PageResponse, SyncProgress } from '../../src/api/types.js';
import type { GuardedPayload } from '../../src/ai/guard.js';
import { hiddenTitles, loadTestEnv, removeCopy, SKIP_REASON, startApp } from './testEnv.js';

const env = loadTestEnv();

describe.skipIf(!env)(`asking an AI about the test environment${env ? '' : ` (skipped: ${SKIP_REASON})`}`, () => {
  const spaces = env?.spaces ?? {};
  const sent: string[] = [];
  let server: http.Server;
  let api: string;

  const call = async <T>(route: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const init =
      body === undefined
        ? {}
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(`${api}${route}`, init);
    return { status: res.status, body: (await res.json()) as T };
  };
  const id = (space: string, title: string): string => spaces[space].pages[title].id;
  const markdownOf = async (space: string, title: string): Promise<string> =>
    (await call<PageResponse>(`/pages/${id(space, title)}?spaceKey=${space}`)).body.parsed.markdown;

  beforeAll(async () => {
    const record = (payload: GuardedPayload): Promise<string> => {
      const text = [payload.system, ...payload.messages.map((m) => m.content)].join('\n');
      sent.push(text);
      // Placeholders are echoed back, so the tests can see the real values restored in the answer.
      return Promise.resolve(`answer ${(text.match(/\[[A-Z_]+-\d+\]/g) ?? []).join(' ')}`);
    };
    ({ server, api } = await startApp(env!, record));
    removeCopy(env!, 'OPS');
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeCopy(env!, 'OPS');
  });

  for (const [key, space] of Object.entries(spaces)) {
    it(`refuses every excluded ${key} page on every route that sends a page to an AI`, async () => {
      const before = sent.length;
      const refusals = space.expectations.excluded.map(async (title) => {
        const analyze = await call('/ai/analyze', {
          pageId: id(key, title),
          spaceKey: key,
          prompt: 'Summarize',
          markdown: 'x',
        });
        const summary = await call(`/space-cache/${key}/pages/${id(key, title)}/metadata/generate`, {});
        return [title, analyze.status, summary.status] as const;
      });
      for (const [title, analyze, summary] of await Promise.all(refusals)) {
        expect(analyze, `analyze ${title}`).toBe(403);
        expect(summary, `summary of ${title}`).toBe(403);
      }
      expect(sent.length).toBe(before);
    });

    it(`never sends an excluded ${key} page as a sub-page of its space's homepage`, async () => {
      const res = await call<AnalyzeResponse>('/ai/analyze', {
        pageId: space.homeId,
        spaceKey: key,
        prompt: 'Summarize everything',
        markdown: '',
        includeChildren: true,
      });
      expect(res.status).toBe(200);
      const payload = sent.at(-1)!;
      expect(
        space.expectations.visible.some((t) => payload.includes(`Sub-Page: ${t}\n`)),
        'no visible page was sent either',
      ).toBe(true);
      for (const title of hiddenTitles(space)) expect(payload).not.toContain(`Sub-Page: ${title}\n`);
    });
  }

  it('refuses a real page that holds a secret, naming the kind and never the value', async () => {
    const [title, type] = Object.entries(spaces.OPS.expectations.guard!.blocked)[0];
    const before = sent.length;
    const res = await call<{ findings: Array<{ type: string }> }>('/ai/analyze', {
      pageId: id('OPS', title),
      spaceKey: 'OPS',
      prompt: 'Summarize',
      markdown: await markdownOf('OPS', title),
    });
    expect(res.status).toBe(422);
    expect(res.body.findings.map((f) => f.type)).toContain(type);
    expect(JSON.stringify(res.body)).not.toContain('IOSFODNN7');
    expect(sent.length).toBe(before);
  });

  it('replaces the personal data on a real page before sending, and restores it in the answer', async () => {
    const [title, values] = Object.entries(spaces.OPS.expectations.guard!.redacted)[0];
    const res = await call<AnalyzeResponse>('/ai/analyze', {
      pageId: id('OPS', title),
      spaceKey: 'OPS',
      prompt: 'Who is on call?',
      markdown: await markdownOf('OPS', title),
    });
    expect(res.status).toBe(200);
    for (const value of values) {
      expect(sent.at(-1)).not.toContain(value);
      expect(res.body.answer).toContain(value);
    }
    expect(res.body.guard.summary).toMatch(/email address/);
  });

  it('leaves a page holding a secret out of a space answer, and says so', async () => {
    const [title] = Object.entries(spaces.OPS.expectations.guard!.blocked)[0];
    const started = (await call<SyncProgress>('/space-cache/sync', { spaceKey: 'OPS' })).body;
    for (let progress = started; progress.status === 'pending' || progress.status === 'running';) {
      // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
      await new Promise((resolve) => setTimeout(resolve, 250));
      // eslint-disable-next-line no-await-in-loop -- as above
      progress = (await call<SyncProgress>(`/space-cache/sync/status/${started.jobId}`)).body;
    }
    const res = await call<AnalyzeResponse>('/space-cache/OPS/ai/ask', { prompt: 'deploy notes aws access ci role' });
    expect(res.status).toBe(200);
    expect(sent.at(-1)).not.toContain('AKIA');
    expect(res.body.guard.summary).toMatch(new RegExp(`Left out .*${title}`));
    expect(res.body.selectedPages?.map((p) => p.title)).not.toContain(title);
  });

  it('carries the visible pages of a branch through a conversation, and never an excluded one', async () => {
    const people = spaces.PEOPLE;
    const scope = {
      scope: { kind: 'branch', spaceKey: 'PEOPLE', pageId: id('PEOPLE', 'Interviews'), title: 'Interviews' },
    };
    const session = (await call<AiSessionView>('/ai/sessions', scope)).body;
    expect((await call(`/ai/sessions/${session.id}/messages`, { prompt: 'What does this branch cover?' })).status).toBe(
      200,
    );
    const second = await call<AiSessionView>(`/ai/sessions/${session.id}/messages`, {
      prompt: 'And who runs interviews?',
    });
    expect(second.body.turns).toHaveLength(4);
    const [first, latest] = sent.slice(-2);
    expect(first).toContain('[Page: Interview Guide]');
    for (const hidden of hiddenTitles(people)) {
      expect(first).not.toContain(`[Page: ${hidden}]`);
      expect(latest).not.toContain(`[Page: ${hidden}]`);
    }
    expect(latest).toMatch(/What does this branch cover\?[\s\S]*And who runs interviews\?/);
  });

  it('refuses a conversation about an excluded page', async () => {
    const scope = { scope: { kind: 'page', spaceKey: 'PEOPLE', pageId: id('PEOPLE', 'Salary Bands') } };
    const session = (await call<AiSessionView>('/ai/sessions', scope)).body;
    expect((await call(`/ai/sessions/${session.id}/messages`, { prompt: 'Summarise' })).status).toBe(403);
  });
});
