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

// Changes from a chat against the real Confluence Data Center test environment: edits are made only
// from the suggestions chosen, from the page as Confluence holds it now, only staged pages are
// written, and a page a colleague changed after its edit was made is never written over.

import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSessionView, BranchRun } from '../../src/api/types.js';
import type { GuardedPayload } from '../../src/ai/guard.js';
import { loadTestEnv, SKIP_REASON, startApp } from './testEnv.js';

const env = loadTestEnv();

type RestPage = { title: string; version: { number: number }; body: { storage: { value: string } } };

describe.skipIf(!env)(`branch runs against the test environment${env ? '' : ` (skipped: ${SKIP_REASON})`}`, () => {
  let server: http.Server;
  let api: string;
  const id = (title: string): string => env!.spaces.PEOPLE.pages[title].id;

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
  const read = (pageId: string): Promise<RestPage> =>
    rest<RestPage>('GET', `/rest/api/content/${pageId}?expand=version,body.storage`);
  const call = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${api}${route}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as T;
  };
  const settled = async (runId: string): Promise<BranchRun> => {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
      const run = await call<BranchRun>('GET', `/branches/runs/${runId}`);
      if (run.status !== 'running') return run;
      // eslint-disable-next-line no-await-in-loop -- as above
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  /** A chat on the Interviews directory reviews it, then edits are made from a suggestion naming both visible pages. */
  const improve = async (beforeEdit: () => Promise<unknown> = () => Promise.resolve()): Promise<BranchRun> => {
    const chat = await call<AiSessionView>('POST', '/ai/sessions', {
      scope: { kind: 'branch', spaceKey: 'PEOPLE', pageId: id('Interviews') },
    });
    const reviewed = await call<AiSessionView>('POST', `/ai/sessions/${chat.id}/suggest`, { kind: 'review' });
    await beforeEdit();
    const ids = [reviewed.suggestions![0].id];
    return settled((await call<BranchRun>('POST', `/ai/sessions/${chat.id}/suggestions/recommend`, { ids })).id);
  };
  /** A colleague's edit of a page in Confluence, made outside the app. */
  const colleagueEdits = async (pageId: string, text: string): Promise<RestPage> => {
    const current = await read(pageId);
    await rest('PUT', `/rest/api/content/${pageId}`, {
      type: 'page',
      title: current.title,
      version: { number: current.version.number + 1 },
      body: { storage: { value: `${current.body.storage.value}<p>${text}</p>`, representation: 'storage' } },
    });
    return current;
  };

  beforeAll(async () => {
    const reply = (payload: GuardedPayload): Promise<string> => {
      const text = [payload.system, ...payload.messages.map((m) => m.content)].join('\n');
      if (!text.includes('<<<PROPOSED_MARKDOWN>>>'))
        return Promise.resolve(
          JSON.stringify({
            findings: [
              { kind: 'redundant', pages: ['Interviews', 'Interview Guide'], detail: 'Both describe the loop' },
            ],
          }),
        );
      const title = /^# Document Title: (.+)$/m.exec(text)?.[1] ?? 'Page';
      return Promise.resolve(
        `<<<CRITIQUE>>>\n- None\n<<<CHANGELOG>>>\n- Applied\n<<<PROPOSED_MARKDOWN>>>\n# ${title}\n\nProposed body.`,
      );
    };
    ({ server, api } = await startApp(env!, reply));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('stages edits for the visible pages a suggestion names, and writes exactly the page accepted', async () => {
    const run = await improve();
    expect(run.items.map((i) => i.title)).toEqual(['Interviews', 'Interview Guide']);
    const before = await read(id('Interview Guide'));
    const marker = `Edited by a person during the end-to-end run ${Date.now()}.`;
    const item = `/branches/runs/${run.id}/items/${id('Interview Guide')}`;
    await call('PUT', `${item}/text`, { text: `# Interview Guide\n\n${marker}` });
    await call('POST', `${item}/decide-all`, { decision: 'accept' });
    await call('POST', `${item}/stage`, { staged: true });

    const checked = await call<BranchRun>('POST', `/branches/runs/${run.id}/check`);
    expect(checked.items[1].status, checked.items[1].message).toBe('checked');
    expect((await read(id('Interview Guide'))).version.number, 'a dry run writes nothing').toBe(before.version.number);

    const pushed = await call<BranchRun>('POST', `/branches/runs/${run.id}/push`);
    expect(pushed.items[1].status, pushed.items[1].message).toBe('pushed');
    const after = await read(id('Interview Guide'));
    expect(after.version.number).toBe(before.version.number + 1);
    expect(after.body.storage.value).toContain(marker);
    expect(pushed.items[0].status, 'the page not accepted was not written').toBe('proposed');
    expect((await read(id('Interviews'))).version.number).toBe(run.items[0].baseVersion);
  });

  it('refuses to push over a page a colleague changed after the proposal', async () => {
    const run = await improve();
    const item = `/branches/runs/${run.id}/items/${id('Interviews')}`;
    await call('POST', `${item}/decide-all`, { decision: 'accept' });
    await call('POST', `${item}/stage`, { staged: true });
    const current = await colleagueEdits(id('Interviews'), 'Added by a colleague.');
    const pushed = await call<BranchRun>('POST', `/branches/runs/${run.id}/push`);
    expect(pushed.items[0].status).toBe('push-failed');
    expect(pushed.items[0].message).toContain('changed in Confluence after the proposal');
    const after = await read(id('Interviews'));
    expect(after.version.number).toBe(current.version.number + 1);
    expect(after.body.storage.value).toContain('Added by a colleague.');
  });

  it('makes an edit from the page a colleague changed after the suggestion was made', async () => {
    const note = `Changed by a colleague before the edit ${Date.now()}.`;
    const run = await improve(() => colleagueEdits(id('Interview Guide'), note));
    const guide = run.items.find((i) => i.pageId === id('Interview Guide'))!;
    expect(guide.baseVersion).toBe((await read(id('Interview Guide'))).version.number);
    expect(guide.original).toContain(note.slice(0, 30));
  });
});
