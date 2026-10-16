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

// Reading the real Confluence Data Center test environment through the app: the connection, the
// doctor, the spaces, every page tree with its exclusions, and the Markdown of real pages.

import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DoctorReport, PageResponse, PageTreeNode } from '../../src/api/types.js';
import { hiddenTitles, loadTestEnv, SKIP_REASON, startApp } from './testEnv.js';

const env = loadTestEnv();

const depths = (nodes: PageTreeNode[], depth = 1, out = new Map<string, number>()): Map<string, number> => {
  for (const n of nodes) {
    out.set(n.title, depth);
    depths(n.children, depth + 1, out);
  }
  return out;
};

describe.skipIf(!env)(
  `the Confluence test environment, read through the app${env ? '' : ` (skipped: ${SKIP_REASON})`}`,
  () => {
    const spaces = env?.spaces ?? {};
    let server: http.Server;
    let api: string;

    const get = async <T>(route: string): Promise<{ status: number; body: T }> => {
      const res = await fetch(`${api}${route}`);
      return { status: res.status, body: (await res.json()) as T };
    };
    const id = (space: string, title: string): string => {
      const page = spaces[space].pages[title];
      if (!page) throw new Error(`the seed manifest has no page "${title}" in ${space}`);
      return page.id;
    };

    beforeAll(async () => {
      ({ server, api } = await startApp(env!));
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('connects with the environment token, and never shows that token', async () => {
      const verify = await fetch(`${api}/auth/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(((await verify.json()) as { user?: { username: string } }).user?.username).toBe('admin');
      const { body } = await get<Record<string, unknown>>('/connection');
      expect(body).toMatchObject({ baseUrl: env!.baseUrl, tokenSet: true, source: 'env' });
      expect(JSON.stringify(body)).not.toContain(env!.token);
    });

    it('passes the doctor, signed in, with a valid test license', async () => {
      const { body } = await get<DoctorReport>('/doctor');
      const level = Object.fromEntries(body.results.map((r) => [r.id, r.level]));
      expect(body.ok, JSON.stringify(body.results.filter((r) => r.level === 'fail'))).toBe(true);
      expect(level).toMatchObject({
        'confluence-auth': 'ok',
        'server-type': 'ok',
        'ignore-files': 'ok',
        'test-license': 'ok',
      });
    });

    it('lists every seeded space', async () => {
      const keys = (await get<{ spaces: Array<{ key: string }> }>('/spaces')).body.spaces.map((s) => s.key);
      for (const key of Object.keys(spaces)) expect(keys).toContain(key);
    });

    for (const [key, space] of Object.entries(spaces)) {
      describe(`space ${key}`, () => {
        it('shows every visible page in the tree, and hides every excluded page and what is below it', async () => {
          const shown = depths((await get<{ tree: PageTreeNode[] }>(`/spaces/${key}/pages`)).body.tree);
          const hidden = hiddenTitles(space);
          const knownIssue = new Set(space.expectations.knownIssueVisible ?? []);
          for (const title of Object.keys(space.pages)) {
            if (knownIssue.has(title)) continue;
            expect(shown.has(title), `${title} should ${hidden.has(title) ? 'be hidden' : 'be shown'}`).toBe(
              !hidden.has(title),
            );
          }
        });

        it('serves the visible pages and answers 404 for the excluded ones', async () => {
          const read = (title: string): Promise<{ title: string; status: number; body: PageResponse }> =>
            get<PageResponse>(`/pages/${id(key, title)}?spaceKey=${key}`).then((r) => ({ title, ...r }));
          for (const { title, status, body } of await Promise.all(space.expectations.visible.map(read))) {
            expect(status, title).toBe(200);
            expect(body.detail.title).toBe(title);
          }
          for (const { title, status } of await Promise.all(space.expectations.excluded.map(read))) {
            expect(status, title).toBe(404);
          }
        });
      });
    }

    // Known defect, deferred to the maintainer (ADR-013): `Restricted/` also hides this page.
    it.todo('shows Unrestricted Access Guide, which the rule Restricted/ should not match');

    it('reads the deep PLAT hierarchy, six levels below the homepage', async () => {
      const shown = depths((await get<{ tree: PageTreeNode[] }>('/spaces/PLAT/pages')).body.tree);
      const homeDepth = shown.get(spaces.PLAT.homeTitle) ?? 0;
      expect(spaces.PLAT.pages['VPN Troubleshooting'].depth).toBe(6);
      expect((shown.get('VPN Troubleshooting') ?? 0) - homeDepth).toBe(6);
    });

    it('converts a real page full of macros to Markdown, with its labels and attachments', async () => {
      const { body } = await get<PageResponse>(`/pages/${id('PLAT', 'Architecture Overview')}?spaceKey=PLAT`);
      const md = body.parsed.markdown;
      expect(md).toContain('```typescript');
      expect(md).toContain('```python');
      expect(md).toMatch(/\|\s*Component\s*\|\s*Owner\s*\|/);
      expect(md).toContain('architecture-diagram.png');
      expect(md).toContain('Do not deploy on Fridays.');
      expect(body.detail.labels).toContain('architecture');
      expect(body.detail.attachments.map((a) => a.title)).toContain('capacity-notes.txt');
    });

    it('tells apart pages that share a title across spaces, and keeps a unicode title intact', async () => {
      const plat = await get<PageResponse>(`/pages/${id('PLAT', 'Database Failover')}?spaceKey=PLAT`);
      const ops = await get<PageResponse>(`/pages/${id('OPS', 'Database Failover')}?spaceKey=OPS`);
      expect(plat.body.detail.id).not.toBe(ops.body.detail.id);
      expect(ops.body.parsed.markdown).toMatch(/duplicate title/);
      const unicode = Object.keys(spaces.OPS.pages).find((t) => t.includes('Ünïcödé'))!;
      const { body } = await get<PageResponse>(`/pages/${id('OPS', unicode)}?spaceKey=OPS`);
      expect(body.detail.title).toBe(unicode);
      expect(body.parsed.markdown).toContain('🚀');
    });

    it('resolves a real page address to its space and page', async () => {
      const pageId = id('OPS', 'Database Failover');
      const res = await fetch(`${api}/spaces/resolve-url`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: `${env!.baseUrl}/pages/viewpage.action?pageId=${pageId}` }),
      });
      expect(await res.json()).toEqual({ pageId, spaceKey: 'OPS' });
    });
  },
);
