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

// Improving a page and writing it to the real Confluence Data Center test environment, including
// the case that matters most: a colleague edits the page after the proposal was made.

import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WriteResult } from '../../src/api/types.js';
import { toEditForm } from '../../src/parser/editForm.js';
import { loadTestEnv, SKIP_REASON, startApp } from './testEnv.js';

const env = loadTestEnv();

type RestPage = { title: string; version: { number: number }; body: { storage: { value: string } } };

describe.skipIf(!env)(`writing a page to the test environment${env ? '' : ` (skipped: ${SKIP_REASON})`}`, () => {
  let server: http.Server;
  let api: string;
  const pageId = (): string => env!.spaces.PEOPLE.pages['Interview Guide'].id;

  // Confluence read and written directly, as a colleague editing in the browser would.
  const rest = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${env!.baseUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${env!.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Atlassian-Token': 'no-check',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${route} answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  };
  const read = (): Promise<RestPage> =>
    rest<RestPage>('GET', `/rest/api/content/${pageId()}?expand=version,body.storage`);
  const post = async <T>(route: string, body: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${api}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };

  beforeAll(async () => {
    const proposal =
      '<<<CRITIQUE>>>\n- Thin\n<<<CHANGELOG>>>\n- Expanded\n<<<PROPOSED_MARKDOWN>>>\n# Interview Guide\n\nProposed.';
    ({ server, api } = await startApp(env!, () => Promise.resolve(proposal)));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('checks a change made from the current page without writing, then writes it', async () => {
    const before = await read();
    const baseVersion = before.version.number;

    const marker = `Edited by a person during the end-to-end run ${Date.now()}.`;
    const markdown = `# Interview Guide\n\n${marker}\n\n- Prepare questions\n- Take **notes**`;
    const dry = await post<WriteResult>(`/pages/${pageId()}/dry-run`, {
      markdown,
      baseVersion,
    });
    expect(dry.status).toBe(200);
    expect((await read()).version.number, 'a dry run writes nothing').toBe(before.version.number);

    const pushed = await post<WriteResult>(`/pages/${pageId()}/push`, {
      markdown,
      baseVersion,
      spaceKey: 'PEOPLE',
    });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    const after = await read();
    expect(after.version.number).toBe(before.version.number + 1);
    expect(after.body.storage.value).toContain(marker);
    expect(after.body.storage.value).toContain('<strong>notes</strong>');
  });

  it('refuses a change that would turn a macro into text, and leaves the macro in place', async () => {
    const runbook = env!.spaces.PLAT.pages['Gateway Runbook'].id;
    const before = await rest<RestPage>('GET', `/rest/api/content/${runbook}?expand=version,body.storage`);
    expect(before.body.storage.value).toContain('ac:name="warning"');

    const pushed = await post<{ error: string }>(`/pages/${runbook}/push`, {
      markdown: '> **warning: Paging policy**\n> Page the owning team before restarting.\n\n1. Check dashboards',
      baseVersion: before.version.number,
    });
    expect(pushed.status).toBe(400);
    expect(pushed.body.error).toContain('⟦1 warning: Paging policy⟧');
    const after = await rest<RestPage>('GET', `/rest/api/content/${runbook}?expand=version,body.storage`);
    expect(after.version.number).toBe(before.version.number);
    expect(after.body.storage.value).toBe(before.body.storage.value);
  });

  it('writes a change to a page with a macro, keeping the macro and its text exactly', async () => {
    const runbook = env!.spaces.PLAT.pages['Gateway Runbook'].id;
    const route = `/rest/api/content/${runbook}?expand=version,body.storage`;
    const before = await rest<RestPage>('GET', route);
    const form = toEditForm(before.body.storage.value);
    expect(form.markdown).toContain('⟦1 warning: Paging policy⟧');
    const pushed = await post<WriteResult>(`/pages/${runbook}/push`, {
      markdown: form.markdown.replace('Restart pods', 'Restart pods one at a time'),
      baseVersion: before.version.number,
    });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    const after = await rest<RestPage>('GET', route);
    const panel = /<ac:structured-macro\b[\s\S]*?<\/ac:structured-macro>/;
    expect(panel.exec(after.body.storage.value)?.[0]).toBe(panel.exec(before.body.storage.value)?.[0]);
    expect(after.body.storage.value).toContain('Restart pods one at a time');
    await rest('PUT', `/rest/api/content/${runbook}`, {
      type: 'page',
      title: after.title,
      version: { number: after.version.number + 1 },
      body: { storage: { value: before.body.storage.value, representation: 'storage' } },
    });
  });

  it("refuses a push made from a version a colleague has since changed, and keeps the colleague's edit", async () => {
    const baseVersion = (await read()).version.number;
    const current = await read();
    const colleague = `${current.body.storage.value}<p>Added by a colleague.</p>`;
    await rest('PUT', `/rest/api/content/${pageId()}`, {
      type: 'page',
      title: current.title,
      version: { number: current.version.number + 1 },
      body: { storage: { value: colleague, representation: 'storage' } },
    });

    const pushed = await post<{ error: string }>(`/pages/${pageId()}/push`, {
      markdown: '# Overwrite',
      baseVersion,
    });
    expect(pushed.status).toBe(409);
    expect(pushed.body.error).toContain('changed in Confluence after the proposal was made');
    const after = await read();
    expect(after.version.number).toBe(current.version.number + 1);
    expect(after.body.storage.value).toContain('Added by a colleague.');
  });
});
