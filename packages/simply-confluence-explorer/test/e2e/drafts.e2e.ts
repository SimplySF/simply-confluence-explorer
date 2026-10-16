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

// New pages against the real Confluence Data Center test environment: the check finds the page that
// already says it, and a page is created only after the author has answered that check.

import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSessionView } from '../../src/api/types.js';
import type { GuardedPayload } from '../../src/ai/guard.js';
import { hiddenTitles, loadTestEnv, SKIP_REASON, startApp } from './testEnv.js';

const env = loadTestEnv();

type RestPage = { title: string; ancestors: Array<{ id: string }>; body: { storage: { value: string } } };

describe.skipIf(!env)(`new pages against the test environment${env ? '' : ` (skipped: ${SKIP_REASON})`}`, () => {
  let server: http.Server;
  let api: string;
  const parent = (): string => env!.spaces.PLAT.pages['Database Runbooks'].id;

  const call = async <T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${api}${route}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const start = (title: string, notes = ''): Promise<{ status: number; body: AiSessionView }> =>
    call<AiSessionView>('POST', '/drafts', { spaceKey: 'PLAT', parentId: parent(), title, notes });

  beforeAll(async () => {
    const reply = (payload: GuardedPayload): Promise<string> => {
      const ids = [...payload.messages[0].content.matchAll(/## Existing page (\d+):/g)].map((m) => m[1]);
      return Promise.resolve(JSON.stringify({ pages: ids.map((pageId) => ({ pageId, overlap: 'medium' })) }));
    };
    ({ server, api } = await startApp(env!, reply));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('finds the existing page before a near-duplicate is written, and offers no excluded page', async () => {
    const { status, body } = await start(
      'Database Failover Procedure',
      'How to fail over the primary database and promote the replica',
    );
    expect(status, JSON.stringify(body)).toBe(200);
    const titles = body.draft!.redundancy!.similar.map((p) => p.title);
    expect(titles).toContain('Database Failover');
    const hidden = hiddenTitles(env!.spaces.PLAT);
    expect(titles.filter((t) => hidden.has(t))).toEqual([]);
  });

  it('creates the page under its parent only after the check is answered, and refuses a title in use', async () => {
    const title = `Replica Lag Alerts ${Date.now()}`;
    const { body: d } = await start(title, 'Alert thresholds for replica lag');
    expect((await call('POST', `/drafts/${d.id}/create`)).status, 'not before the check is answered').toBe(409);
    await call('POST', `/drafts/${d.id}/decision`, { decision: 'continue' });
    await call('PUT', `/drafts/${d.id}`, {
      markdown: `# ${title}\n\nAlert when lag exceeds **30 seconds**.\n\n- Page the DBA\n- Check replication slots`,
    });

    const checked = await call('POST', `/drafts/${d.id}/check`);
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    const created = await call<AiSessionView>('POST', `/drafts/${d.id}/create`);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const newId = created.body.draft!.createdPageId!;
    expect(newId).toMatch(/^\d+$/);

    const res = await fetch(`${env!.baseUrl}/rest/api/content/${newId}?expand=ancestors,body.storage`, {
      headers: { Authorization: `Bearer ${env!.token}`, Accept: 'application/json' },
    });
    const page = (await res.json()) as RestPage;
    expect(page.title).toBe(title);
    expect(page.ancestors.at(-1)?.id, 'under the chosen parent').toBe(parent());
    expect(page.body.storage.value).toMatch(/30 seconds/);

    const { body: dup } = await start(title);
    await call('POST', `/drafts/${dup.id}/decision`, { decision: 'continue' });
    await call('PUT', `/drafts/${dup.id}`, { markdown: `# ${title}\n\nAgain.` });
    const again = await call<{ error: string }>('POST', `/drafts/${dup.id}/create`);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error).toMatch(/already exists in PLAT/);
  });
});
