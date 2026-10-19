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

// Section reviews against the real Confluence Data Center test environment: edits are staged only
// from the suggestions chosen, only accepted pages are written, and a page a colleague changed after
// its edit was made is never written over.

import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BranchRun } from '../../src/api/types.js';
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
  /** Reviews the Interviews section, then stages edits from a suggestion that names both of its visible pages. */
  const improve = async (): Promise<BranchRun> => {
    const review = await settled(
      (
        await call<BranchRun>('POST', '/branches/runs', {
          spaceKey: 'PEOPLE',
          source: { kind: 'section', rootPageId: id('Interviews') },
          pageIds: [id('Interviews'), id('Interview Guide')],
        })
      ).id,
    );
    return settled((await call<BranchRun>('POST', `/branches/runs/${review.id}/apply`, { findings: [0] })).id);
  };

  beforeAll(async () => {
    const reply = (payload: GuardedPayload): Promise<string> => {
      const text = [payload.system, ...payload.messages.map((m) => m.content)].join('\n');
      if (text.includes('"findings"'))
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
    await call('PATCH', `/branches/runs/${run.id}/items/${id('Interview Guide')}`, {
      decision: 'accept',
      proposed: `# Interview Guide\n\n${marker}`,
    });

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
    await call('PATCH', `/branches/runs/${run.id}/items/${id('Interviews')}`, { decision: 'accept' });
    const current = await read(id('Interviews'));
    await rest('PUT', `/rest/api/content/${id('Interviews')}`, {
      type: 'page',
      title: current.title,
      version: { number: current.version.number + 1 },
      body: {
        storage: { value: `${current.body.storage.value}<p>Added by a colleague.</p>`, representation: 'storage' },
      },
    });
    const pushed = await call<BranchRun>('POST', `/branches/runs/${run.id}/push`);
    expect(pushed.items[0].status).toBe('push-failed');
    expect(pushed.items[0].message).toContain('changed in Confluence after the proposal');
    const after = await read(id('Interviews'));
    expect(after.version.number).toBe(current.version.number + 1);
    expect(after.body.storage.value).toContain('Added by a colleague.');
  });
});
