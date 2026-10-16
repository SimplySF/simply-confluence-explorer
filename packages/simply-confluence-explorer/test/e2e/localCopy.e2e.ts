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

// Syncing a space from the real Confluence Data Center test environment to disk, and working with
// the copy: the cached tree, exclusions on disk, the ZIP, and removing a page.

import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PageTreeNode, SyncProgress } from '../../src/api/types.js';
import { hiddenTitles, loadTestEnv, SKIP_REASON, startApp } from './testEnv.js';

const env = loadTestEnv();
const SPACE = 'PEOPLE';

const titles = (nodes: PageTreeNode[]): string[] => nodes.flatMap((n) => [n.title, ...titles(n.children)]);

function removeCopy(): void {
  const dir = path.join(env!.dataDir, 'spaces', SPACE);
  for (const sub of ['pages_cache', 'pages', 'metadata', 'toc.json', 'TOC.md', 'manifest.json']) {
    fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  }
}

describe.skipIf(!env)(`a space synced from the test environment${env ? '' : ` (skipped: ${SKIP_REASON})`}`, () => {
  const space = env?.spaces[SPACE];
  let server: http.Server;
  let api: string;
  const cached = (title: string): string =>
    path.join(env!.dataDir, 'spaces', SPACE, 'pages_cache', `${space!.pages[title].id}.json`);
  const call = async <T>(route: string, body?: unknown): Promise<T> => {
    const init =
      body === undefined
        ? {}
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    return (await (await fetch(`${api}${route}`, init)).json()) as T;
  };

  beforeAll(async () => {
    removeCopy();
    ({ server, api } = await startApp(env!));
    const started = await call<SyncProgress>('/space-cache/sync', { spaceKey: SPACE });
    for (let progress = started; ;) {
      if (['completed', 'failed', 'cancelled'].includes(progress.status)) {
        expect(progress.status, JSON.stringify(progress.errors)).toBe('completed');
        expect(progress.errorCount).toBe(0);
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
      await new Promise((resolve) => setTimeout(resolve, 250));
      // eslint-disable-next-line no-await-in-loop -- as above
      progress = await call<SyncProgress>(`/space-cache/sync/status/${started.jobId}`);
    }
  });
  // The copy is removed before and after, so this suite starts from Confluence's state and leaves
  // nothing behind for another suite to read. The seeded exclusion rules are kept.
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeCopy();
  });

  it('writes every visible page and no excluded one', () => {
    const hidden = hiddenTitles(space!);
    for (const title of Object.keys(space!.pages)) expect(fs.existsSync(cached(title)), title).toBe(!hidden.has(title));
  });

  it('serves the tree from disk, with the excluded pages still hidden', async () => {
    const { tree, isLocal } = await call<{ tree: PageTreeNode[]; isLocal: boolean }>(`/spaces/${SPACE}/pages`);
    expect(isLocal).toBe(true);
    expect(titles(tree)).toContain('Benefits Overview');
    for (const title of hiddenTitles(space!)) expect(titles(tree)).not.toContain(title);
  });

  it('builds a table of contents and a ZIP of the visible pages only', async () => {
    const { toc } = await call<{ toc: Array<{ title: string }> }>(`/space-cache/${SPACE}/toc`);
    expect(toc[0].title).toBe(space!.homeTitle);
    const zip = Buffer.from(await (await fetch(`${api}/space-cache/${SPACE}/zip`)).arrayBuffer()).toString('latin1');
    expect(zip).toContain('Benefits Overview.md');
    expect(zip).not.toContain('Salary Bands');
  });

  it('removes a page from this machine', async () => {
    const result = await call<{ purgedCount: number }>(
      `/space-cache/${SPACE}/pages/${space!.pages['Benefits Overview'].id}/purge`,
      {},
    );
    expect(result.purgedCount).toBe(1);
    expect(fs.existsSync(cached('Benefits Overview'))).toBe(false);
  });
});
