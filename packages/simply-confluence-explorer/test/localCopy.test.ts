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

// Keeping a copy of a space on this machine. An excluded page must never be written to disk, and a
// page already on disk must be removable, with the ZIP and the table of contents following suit.

import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectations } from '../../../test-env/fixtures/dataset.mjs';
import type { PageResponse, PageTreeNode, SpaceTocNode, SyncProgress, SyncedSpace } from '../src/api/types.js';
import { ConfluenceClient } from '../src/confluence/client.js';
import { createServer } from '../src/server.js';
import { FAKE_TOKEN, startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(() => fake.close());

type App = { base: string; dataDir: string; close: () => Promise<void> };

async function startApp(ignore?: Record<string, string[]>): Promise<App> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-sync-'));
  fake.writeIgnoreFiles(dataDir);
  for (const [key, lines] of Object.entries(ignore ?? {})) {
    fs.writeFileSync(path.join(dataDir, 'spaces', key, '.confluenceignore'), `${lines.join('\n')}\n`);
  }
  const server: http.Server = createServer({
    webRoot: dataDir,
    dataDir,
    env: { CONFLUENCE_URL: fake.url, CONFLUENCE_PERSONAL_TOKEN: FAKE_TOKEN },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return { base, dataDir, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const call = async <T>(app: App, route: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await fetch(
    `${app.base}${route}`,
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  return { status: res.status, body: (await res.json()) as T };
};

async function sync(app: App, spaceKey: string, rootPageId?: string): Promise<SyncProgress> {
  const { body: started } = await call<SyncProgress>(app, '/space-cache/sync', { spaceKey, rootPageId });
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
    const { body } = await call<SyncProgress>(app, `/space-cache/sync/status/${started.jobId}`);
    if (['completed', 'failed', 'cancelled'].includes(body.status)) return body;
    // eslint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const titles = (nodes: PageTreeNode[]): string[] => nodes.flatMap((n) => [n.title, ...titles(n.children)]);
const cacheFile = (app: App, spaceKey: string, id: string): string =>
  path.join(app.dataDir, 'spaces', spaceKey, 'pages_cache', `${id}.json`);

describe('syncing a space', () => {
  it('writes every visible page to disk and no excluded page, nor anything below one', async () => {
    const app = await startApp();
    try {
      const progress = await sync(app, 'PLAT');
      expect(progress.status).toBe('completed');
      expect(progress.errorCount, JSON.stringify(progress.errors)).toBe(0);
      for (const page of fake.pages.values()) {
        if (page.spaceKey !== 'PLAT') continue;
        const hidden = [page.title, ...page.ancestors.map((a) => a.title)].some((t) =>
          expectations.PLAT.excluded.includes(t),
        );
        if (expectations.PLAT.knownIssueVisible?.includes(page.title)) continue;
        expect(fs.existsSync(cacheFile(app, 'PLAT', page.id)), page.title).toBe(!hidden);
      }
      const md = path.join(
        app.dataDir,
        'spaces',
        'PLAT',
        'pages',
        'Platform Engineering Home',
        'Architecture Overview.md',
      );
      expect(fs.readFileSync(md, 'utf8')).toContain('title: Architecture Overview');
      const attachment = path.join(
        app.dataDir,
        'spaces',
        'PLAT',
        'pages',
        'Platform Engineering Home',
        'Architecture Overview_attachments',
        'capacity-notes.txt',
      );
      expect(fs.existsSync(attachment)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('never writes a page whose parent is excluded by its id, the same way the tree hides it', async () => {
    const restricted = fake.page('PLAT', 'Restricted');
    const app = await startApp({ PLAT: [`id:${restricted.id}`] });
    try {
      await sync(app, 'PLAT');
      for (const id of [restricted.id, ...restricted.children])
        expect(fs.existsSync(cacheFile(app, 'PLAT', id)), id).toBe(false);
      const below = fake.page('PLAT', 'Production Credentials');
      expect((await call(app, `/pages/${below.id}?spaceKey=PLAT&live=1`)).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('downloads only what changed when the space is synced again', async () => {
    const app = await startApp();
    try {
      const first = await sync(app, 'OPS');
      expect(first.downloadedCount).toBeGreaterThan(0);
      const page = fake.page('OPS', 'Database Failover');
      page.version++;
      const second = await sync(app, 'OPS');
      expect(second.downloadedCount).toBe(1);
      expect((await call<PageResponse>(app, `/pages/${page.id}`)).body.detail.version).toBe(page.version);
    } finally {
      await app.close();
    }
  });

  it('serves the synced tree and pages from disk, with exclusions still applied', async () => {
    const app = await startApp();
    try {
      await sync(app, 'PEOPLE');
      const { body } = await call<{ tree: PageTreeNode[]; isLocal: boolean }>(app, '/spaces/PEOPLE/pages');
      expect(body.isLocal).toBe(true);
      expect(titles(body.tree)).toContain('Benefits Overview');
      for (const title of expectations.PEOPLE.excluded) expect(titles(body.tree)).not.toContain(title);
      const page = await call<PageResponse>(app, `/pages/${fake.page('PEOPLE', 'Benefits Overview').id}`);
      expect(page.body.isLocal).toBe(true);
      const spaces = (await call<{ spaces: SyncedSpace[] }>(app, '/space-cache/cached')).body.spaces;
      expect(spaces.map((s) => s.spaceKey)).toEqual(['PEOPLE']);
      expect(spaces[0].hasTOC).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('a second sync of a space', () => {
  it('gets the sync already running, which a reloaded browser can find again', async () => {
    const app = await startApp();
    try {
      const [first, second] = await Promise.all([
        call<SyncProgress>(app, '/space-cache/sync', { spaceKey: 'PLAT' }),
        call<SyncProgress>(app, '/space-cache/sync', { spaceKey: 'plat' }),
      ]);
      expect(second.body.jobId).toBe(first.body.jobId);
      const active = await call<{ activeJob: SyncProgress | null }>(app, '/space-cache/PLAT/sync/active');
      expect(active.body.activeJob?.jobId).toBe(first.body.jobId);
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
        const { body } = await call<SyncProgress>(app, `/space-cache/sync/status/${first.body.jobId}`);
        if (body.status === 'completed') break;
        // eslint-disable-next-line no-await-in-loop -- as above
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(
        (await call<{ activeJob: SyncProgress | null }>(app, '/space-cache/PLAT/sync/active')).body.activeJob,
      ).toBe(null);
    } finally {
      await app.close();
    }
  });
});

describe('a synced space', () => {
  it('has a table of contents and knows what is below each page', async () => {
    const app = await startApp();
    try {
      await sync(app, 'PEOPLE');
      const toc = (await call<{ toc: SpaceTocNode[] }>(app, '/space-cache/PEOPLE/toc')).body.toc;
      expect(toc[0].title).toBe('People and HR Home');
      expect(toc[0].children.map((c) => c.title)).toContain('Policies');
      const policies = fake.page('PEOPLE', 'Policies');
      const below = (await call<{ titles: string[] }>(app, `/space-cache/PEOPLE/pages/${policies.id}/descendants`)).body
        .titles;
      expect(below).toContain('Remote Work Policy');
      expect(fs.readFileSync(path.join(app.dataDir, 'spaces', 'PEOPLE', 'TOC.md'), 'utf8')).toContain(
        '- [People and HR Home]',
      );
    } finally {
      await app.close();
    }
  });

  it('deletes the copies a new rule excludes when the rule is saved with purge', async () => {
    const app = await startApp();
    try {
      await sync(app, 'OPS');
      const page = fake.page('OPS', 'Database Failover');
      const saved = await call<{ purged?: { purgedCount: number } }>(app, '/space-cache/OPS/ignore', {
        patterns: ['Database Failover'],
        purge: true,
      });
      expect(saved.body.purged?.purgedCount).toBe(1);
      expect(fs.existsSync(cacheFile(app, 'OPS', page.id))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('leaves an excluded copy out of the ZIP even when the rule was saved without purging', async () => {
    const app = await startApp();
    try {
      await sync(app, 'OPS');
      await call(app, '/space-cache/OPS/ignore', { patterns: ['Database Failover'] });
      const res = await fetch(`${app.base}/space-cache/OPS/zip`);
      expect(res.headers.get('content-type')).toBe('application/zip');
      const zip = Buffer.from(await res.arrayBuffer()).toString('latin1');
      expect(zip).toContain('On-Call Handbook.md');
      expect(zip).not.toContain('Database Failover.md');
    } finally {
      await app.close();
    }
  });

  it('removes one page, or a page and everything below it, and can add a rule so it stays away', async () => {
    const app = await startApp();
    try {
      await sync(app, 'PEOPLE');
      const policies = fake.page('PEOPLE', 'Policies');
      const result = await call<{ purgedCount: number }>(app, `/space-cache/PEOPLE/pages/${policies.id}/purge`, {
        includeSubPages: true,
        addToIgnore: true,
      });
      expect(result.body.purgedCount).toBeGreaterThan(1);
      for (const id of [policies.id, ...policies.children])
        expect(fs.existsSync(cacheFile(app, 'PEOPLE', id))).toBe(false);
      expect((await call<{ patterns: string[] }>(app, '/space-cache/PEOPLE/ignore')).body.patterns).toContain(
        'Policies/',
      );
    } finally {
      await app.close();
    }
  });

  it('forgets a page whose Markdown a person deleted from the folder', async () => {
    const app = await startApp();
    try {
      await sync(app, 'OPS');
      const page = fake.page('OPS', 'Database Failover');
      fs.rmSync(path.join(app.dataDir, 'spaces', 'OPS', 'pages', 'Operations Home', 'Database Failover.md'));
      expect((await call<{ purgedCount: number }>(app, '/space-cache/OPS/cache/purge', {})).body.purgedCount).toBe(1);
      expect(fs.existsSync(cacheFile(app, 'OPS', page.id))).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('downloading an attachment', () => {
  it('refuses an address outside the configured Confluence, so the token goes nowhere else', async () => {
    const client = new ConfluenceClient({ baseUrl: fake.url, token: FAKE_TOKEN });
    await expect(client.downloadAttachment('https://attacker.example/download/x')).rejects.toMatchObject({
      status: 400,
    });
    expect((await client.downloadAttachment(`${fake.url}/download/attachments/1/a.txt`)).toString()).toContain(
      'attachment',
    );
  });
});
