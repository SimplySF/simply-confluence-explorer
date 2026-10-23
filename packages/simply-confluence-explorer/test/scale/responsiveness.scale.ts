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

// The server keeps answering while a 3,200-page space is indexed and asked about, which once froze it
// for minutes (ADR-054, design doc 0008). It is timed here rather than in CI: on a shared CI machine a
// pass or a failure says more about the machine than about the app (ADR-057). Run it with
// `pnpm run test:scale` on a real machine after changing code that reads a whole space.

import { PerformanceObserver } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { DIRECTORY, startLargeSpace, walk } from '../support/largeSpace.js';

describe('a 3,200-page space', () => {
  it('never keeps a health check waiting 250 ms while it is indexed and asked about', async () => {
    const space = await startLargeSpace();
    // The first request starts this process's HTTP client, which is not the server's doing, so it is
    // made before anything is measured.
    await fetch(`${space.base}/health`);
    const waits: number[] = [];
    // Each long wait is labelled with the step under way and the CPU time this process used in it,
    // and long garbage collections are noted, so a failure says what held the server.
    let step = '';
    const labelled: string[] = [];
    const collections: number[] = [];
    const gc = new PerformanceObserver((list) =>
      list.getEntries().forEach((e) => e.duration > 50 && collections.push(Math.round(e.duration))),
    );
    gc.observe({ entryTypes: ['gc'] });
    let working = true;
    const heartbeat = (async (): Promise<void> => {
      while (working) {
        const at = Date.now();
        const cpu = process.cpuUsage();
        // eslint-disable-next-line no-await-in-loop -- each check waits for its answer, which is what is measured
        await fetch(`${space.base}/health`);
        const wait = Date.now() - at;
        waits.push(wait);
        const spent = process.cpuUsage(cpu);
        if (wait > 100) labelled.push(`${step}: ${wait} ms (CPU ${Math.round((spent.user + spent.system) / 1000)} ms)`);
        // eslint-disable-next-line no-await-in-loop -- as above
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    try {
      const { status } = await walk(space, (s) => (step = s));
      expect(status).toBe('completed');
    } finally {
      working = false;
      await heartbeat;
      gc.disconnect();
      await space.close();
    }
    expect(waits.length).toBeGreaterThan(5);
    expect(
      Math.max(...waits),
      `long waits: ${labelled.join(', ') || 'none'}; garbage collections over 50 ms: ${collections.join(', ') || 'none'}`,
    ).toBeLessThan(250);
  }, 300_000);

  it('answers the first tree and the list of synced spaces within 2 s of a cold start, while it indexes', async () => {
    const space = await startLargeSpace({ startupIndexMs: 0 });
    try {
      const timed = async (route: string): Promise<number> => {
        const at = Date.now();
        await (await fetch(`${space.base}${route}`)).text();
        return Date.now() - at;
      };
      const [tree, synced] = await Promise.all([timed('/spaces/BIG/pages'), timed('/space-cache/cached')]);
      expect(tree, 'the page tree').toBeLessThan(2000);
      expect(synced, 'the synced spaces').toBeLessThan(2000);
    } finally {
      await space.close();
    }
  }, 120_000);

  it("lists a space's tags within 200 ms once its catalog is built, where every page was read each time", async () => {
    const space = await startLargeSpace();
    try {
      const tags = async (): Promise<{ ms: number; building: boolean }> => {
        const at = Date.now();
        const body = (await (await fetch(`${space.base}/space-cache/BIG/tags`)).json()) as { building?: unknown };
        return { ms: Date.now() - at, building: !!body.building };
      };
      const started = Date.now();
      // eslint-disable-next-line no-await-in-loop -- waits for the first build, as the Tags view does
      while ((await tags()).building) await new Promise((resolve) => setTimeout(resolve, 100));
      const built = Date.now() - started;
      expect((await tags()).ms, `after a first build of ${built} ms`).toBeLessThan(200);
    } finally {
      await space.close();
    }
  }, 120_000);

  it('answers what a person does in a chat within limits on a realistic space, and the server never stalls', async () => {
    const space = await startLargeSpace({ realistic: true });
    const get = (route: string): Promise<Response> => fetch(`${space.base}${route}`);
    const post = (route: string, body: unknown): Promise<Response> =>
      fetch(`${space.base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    await get('/health');
    const stalls: number[] = [];
    let working = true;
    const heartbeat = (async (): Promise<void> => {
      while (working) {
        const at = Date.now();
        // eslint-disable-next-line no-await-in-loop -- each check waits for its answer, which is what is measured
        await get('/health');
        stalls.push(Date.now() - at);
        // eslint-disable-next-line no-await-in-loop -- as above
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const times: Record<string, number> = {};
    const timed = async (name: string, call: () => Promise<Response>): Promise<unknown> => {
      const at = Date.now();
      const body: unknown = await (await call()).json();
      times[name] = Date.now() - at;
      return body;
    };
    try {
      const list = (await timed('chat list', () => get('/ai/sessions?spaceKey=BIG&kind=space,pages'))) as {
        sessions: Array<{ id: string; turnCount: number }>;
      };
      const longest = [...list.sessions].sort((a, b) => b.turnCount - a.turnCount)[0];
      await timed('open a long chat', () => get(`/ai/sessions/${longest.id}`));
      await timed('page chats list', () => get('/ai/sessions?spaceKey=BIG&kind=page,branch'));
      await timed('coverage, first', () =>
        post('/space-cache/BIG/metadata/coverage', { dirs: [DIRECTORY], sessionId: longest.id }),
      );
      const building = Date.now();
      let state: { indexing?: unknown } = { indexing: true };
      /* eslint-disable no-await-in-loop -- asks again until the index is built, as the chat does */
      while (state.indexing) {
        const answer = await post('/space-cache/BIG/metadata/coverage', { dirs: [DIRECTORY] });
        state = (await answer.json()) as typeof state;
      }
      /* eslint-enable no-await-in-loop */
      times['search index built'] = Date.now() - building;
      await timed('coverage, again', () =>
        post('/space-cache/BIG/metadata/coverage', { dirs: [DIRECTORY], sessionId: longest.id }),
      );
      await timed('coverage, a directory', () => post('/space-cache/BIG/metadata/coverage', { rootPageId: DIRECTORY }));
      await timed('tags', () => get('/space-cache/BIG/tags'));
      await timed('observability logs', () => get('/observe/logs?range=24h'));
      await timed('observability missing trace', () => get('/observe/traces/none'));
      await timed('observability now', () => get('/observe/now'));
    } finally {
      working = false;
      await heartbeat;
      await space.close();
    }
    const report = Object.entries(times)
      .map(([k, v]) => `${k}: ${v} ms`)
      .join(', ');
    // The times are printed for the record of a change, as well as checked.
    process.stdout.write(`realistic space: ${report}; longest stall ${Math.max(...stalls)} ms\n`);
    expect(times['chat list'], report).toBeLessThan(300);
    expect(times['open a long chat'], report).toBeLessThan(300);
    expect(times['coverage, first'], report).toBeLessThan(500);
    expect(times['coverage, again'], report).toBeLessThan(500);
    expect(times['coverage, a directory'], report).toBeLessThan(500);
    expect(times['observability logs'], report).toBeLessThan(300);
    expect(times['observability missing trace'], report).toBeLessThan(300);
    expect(Math.max(...stalls), report).toBeLessThan(250);
  }, 600_000);
});
