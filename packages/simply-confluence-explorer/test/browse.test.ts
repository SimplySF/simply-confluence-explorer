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

// The routes that read Confluence live. Excluded pages must stay out of the browser as well as away
// from an AI: a tree leaves them and everything below them out, and reading one answers 404.

import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectations } from '../../../test-env/fixtures/dataset.mjs';
import type { PageResponse, PageTreeNode } from '../src/api/types.js';
import { parseConfluenceInput } from '../src/routes/browse.js';
import { createServer } from '../src/server.js';
import { FAKE_TOKEN, startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';

let fake: FakeConfluence;
let server: http.Server;
let base: string;

beforeAll(async () => {
  fake = await startFakeConfluence();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-browse-'));
  fake.writeIgnoreFiles(dataDir);
  server = createServer({
    webRoot: dataDir,
    dataDir,
    env: { CONFLUENCE_URL: fake.url, CONFLUENCE_PERSONAL_TOKEN: FAKE_TOKEN },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fake.close();
});

const get = async <T>(route: string): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${base}${route}`);
  return { status: res.status, body: (await res.json()) as T };
};
const post = async <T>(route: string, body: unknown): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
};
const titles = (nodes: PageTreeNode[]): string[] => nodes.flatMap((n) => [n.title, ...titles(n.children)]);

describe('reading Confluence', () => {
  for (const [spaceKey, expected] of Object.entries(expectations)) {
    it(`shows every visible ${spaceKey} page in the tree, and none of the excluded ones or what is below them`, async () => {
      const { body } = await get<{ tree: PageTreeNode[] }>(`/api/spaces/${spaceKey}/pages`);
      const shown = titles(body.tree);
      for (const title of expected.visible) expect(shown, title).toContain(title);
      for (const title of expected.excluded) expect(shown, title).not.toContain(title);
      const hiddenBelow = [...fake.pages.values()].filter(
        (p) => p.spaceKey === spaceKey && p.ancestors.some((a) => expected.excluded.includes(a.title)),
      );
      for (const page of hiddenBelow) expect(shown, page.title).not.toContain(page.title);
    });
  }

  it('answers an excluded page with a 404, and converts a visible one to Markdown', async () => {
    expect((await get(`/api/pages/${fake.page('PEOPLE', 'Salary Bands').id}`)).status).toBe(404);
    expect((await get(`/api/pages/${fake.page('PLAT', 'Production Credentials').id}?spaceKey=PLAT`)).status).toBe(404);
    const { status, body } = await get<PageResponse>(`/api/pages/${fake.page('OPS', 'Database Failover').id}`);
    expect(status).toBe(200);
    expect(body.parsed.markdown).toMatch(/^---\nid: "\d+"\ntitle: Database Failover\nspace: OPS/);
  });

  it('lists spaces and finds a space by key', async () => {
    expect(
      (await get<{ spaces: Array<{ key: string }> }>('/api/spaces?query=plat')).body.spaces.map((s) => s.key),
    ).toEqual(['PLAT']);
    expect((await get<{ name: string }>('/api/spaces/detail/OPS')).body.name).toBe('Operations');
  });

  it('resolves a pasted address or page id to its space and page', async () => {
    const id = fake.page('OPS', 'Database Failover').id;
    expect(
      (await post('/api/spaces/resolve-url', { input: `https://wiki.example.com/pages/viewpage.action?pageId=${id}` }))
        .body,
    ).toEqual({ pageId: id, spaceKey: 'OPS' });
    expect(
      (await post<{ pageId: string }>('/api/spaces/resolve-url', { input: 'https://wiki.example.com/display/PEOPLE' }))
        .body.pageId,
    ).toBe(fake.page('PEOPLE', 'People and HR Home').id);
    expect((await post('/api/spaces/resolve-url', { input: 'not a confluence address' })).status).toBe(404);
  });

  it('converts a pasted storage-format snippet without reading or storing anything', async () => {
    expect(
      (await post<{ markdown: string }>('/api/parse', { storageXml: '<h2>Hi</h2><p>there</p>' })).body.markdown,
    ).toBe('## Hi\n\nthere');
  });

  it("saves and reads back a space's exclusion rules", async () => {
    expect((await post('/api/space-cache/OPS/ignore', { patterns: ['Deploy Notes', ' '] })).body).toEqual({
      spaceKey: 'OPS',
      patterns: ['Deploy Notes'],
    });
    expect((await get('/api/space-cache/OPS/ignore')).body).toEqual({ spaceKey: 'OPS', patterns: ['Deploy Notes'] });
    expect((await post('/api/space-cache/OPS/ignore', { patterns: 'Deploy Notes' })).status).toBe(400);
    await post('/api/space-cache/OPS/ignore', { patterns: [] });
  });

  it('tests a typed connection without sending the saved token to a URL it was not saved for', async () => {
    const before = fake.tokens.length;
    const res = await post<{ success: boolean }>('/api/auth/verify', { baseUrl: 'http://127.0.0.1:9' });
    expect(res.body.success).toBe(false);
    expect(fake.tokens.length, 'nothing reached the saved Confluence').toBe(before);
    expect((await post<{ success: boolean }>('/api/auth/verify', {})).body.success).toBe(true);
  });

  it('ignores any Confluence a request tries to name in its headers', async () => {
    const res = await fetch(`${base}/api/spaces`, {
      headers: { 'x-confluence-url': 'https://attacker.example', 'x-confluence-token': 'x' },
    });
    expect(res.status).toBe(200);
    // The answer is the configured Confluence's spaces: the headers named nowhere it went.
    expect(((await res.json()) as { spaces: Array<{ key: string }> }).spaces.map((s) => s.key)).toEqual(
      Object.keys(expectations),
    );
  });
});

describe('a pasted Confluence address', () => {
  it('yields its page id or space key in each form Server and Data Center use', () => {
    expect(parseConfluenceInput(' 12345 ')).toEqual({ pageId: '12345' });
    expect(parseConfluenceInput('https://w.example.com/pages/viewpage.action?pageId=77')).toEqual({
      pageId: '77',
      spaceKey: undefined,
    });
    expect(parseConfluenceInput('https://w.example.com/spaces/ops/pages/88/Title')).toEqual({
      pageId: '88',
      spaceKey: 'OPS',
    });
    expect(parseConfluenceInput('https://w.example.com/display/PLAT/Some+Page')).toEqual({
      pageId: undefined,
      spaceKey: 'PLAT',
    });
  });
});
