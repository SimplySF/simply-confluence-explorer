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

// The Confluence client reads through simply-atlassian-core and answers its failures with this
// app's statuses. These tests run it against the fake Confluence, which serves the test dataset.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spaces } from '../../../test-env/fixtures/dataset.mjs';
import type { PageTreeNode } from '../src/api/types.js';
import { ConfluenceClient } from '../src/confluence/client.js';
import { FAKE_TOKEN, startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(() => fake.close());

const client = (token = FAKE_TOKEN): ConfluenceClient => new ConfluenceClient({ baseUrl: fake.url, token });
const titles = (nodes: PageTreeNode[]): string[] => nodes.flatMap((n) => [n.title, ...titles(n.children)]);

describe('the Confluence client', () => {
  it('reads every page of a space, following each page of results', async () => {
    const tree = await client().getPageTree('PLAT');
    const expected = [...fake.pages.values()].filter((p) => p.spaceKey === 'PLAT').map((p) => p.title);
    expect(titles(tree).sort()).toEqual(expected.sort());
    expect(fake.requests.some((r) => r.includes('/child/page') && r.includes('start=3'))).toBe(true);
  });

  it('reads the tree below a chosen page', async () => {
    const tree = await client().getPageTree('PLAT', fake.page('PLAT', 'Restricted').id);
    expect(tree[0].title).toBe('Restricted');
    expect(titles(tree[0].children)).toContain('Production Credentials');
  });

  it('reads a page with its body, labels, attachments and ancestors', async () => {
    const page = await client().getPageDetail(fake.page('PLAT', 'Architecture Overview').id);
    expect(page.storageXml).toContain('<h1>Architecture Overview</h1>');
    expect(page.labels).toEqual(['architecture', 'reference']);
    expect(page.attachments.map((a) => a.title)).toEqual(['architecture-diagram.png', 'capacity-notes.txt']);
    expect(page.ancestors.map((a) => a.title)).toEqual(['Platform Engineering Home']);
  });

  it('reads every attachment of a page with more than one page of them, which stopped at the first 25', async () => {
    const page = fake.page('PLAT', 'Services');
    const saved = page.attachments;
    page.attachments = Array.from({ length: 30 }, (_, i) => ({
      title: `shot-${i}.png`,
      content: Buffer.from('x'),
      type: 'image/png',
    }));
    try {
      expect((await client().getPageDetail(page.id)).attachments).toHaveLength(30);
    } finally {
      page.attachments = saved;
    }
  });

  it('lists every space, filters by key or name, and finds an exact key the list does not match', async () => {
    expect((await client().getSpaces()).map((s) => s.key)).toEqual(spaces.map((s) => s.key));
    expect((await client().getSpaces('operat')).map((s) => s.key)).toEqual(['OPS']);
    expect(await client().getSpaces('NOPE')).toEqual([]);
  });

  it('reports a rejected token as a failed check and as a 502, never as a 401 to the browser', async () => {
    expect((await client('wrong').verify()).success).toBe(false);
    await expect(client('wrong').getSpace('PLAT')).rejects.toMatchObject({ status: 502, message: /refused the token/ });
  });

  it('answers a page Confluence does not have with a 404', async () => {
    await expect(client().getPageDetail('999999')).rejects.toMatchObject({ status: 404 });
  });

  it('answers with a 400 that says how to connect when no Confluence is configured', async () => {
    await expect(new ConfluenceClient({ baseUrl: '', token: '' }).getSpaces()).rejects.toMatchObject({
      status: 400,
      message: /Confluence is not configured/,
    });
  });
});

describe('reading from a slow Confluence', () => {
  const childReads = (from: number): number =>
    fake.requests.slice(from).filter((r) => r.includes('/child/page')).length;

  it('reads a tree once when the sidebar and a sync ask for it together, counting what it finds, where each read it alone', async () => {
    let from = fake.requests.length;
    await client().getPageTree('PLAT');
    const alone = childReads(from);
    from = fake.requests.length;
    const found: number[] = [];
    const [sidebar, sync] = await Promise.all([
      client().getPageTree('PLAT'),
      client().getPageTree('PLAT', undefined, (n) => found.push(n)),
    ]);
    expect(sync).toBe(sidebar);
    expect(childReads(from)).toBe(alone);
    expect(found.at(-1)).toBe(titles(sync).length);
  });

  it('gives up on a request after the time set for the connection, saying where to give it longer', async () => {
    const silent = http.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const slow = new ConfluenceClient({
        baseUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
        token: FAKE_TOKEN,
        timeoutSeconds: 0.2,
      });
      await expect(slow.getPageDetail('1000')).rejects.toMatchObject({
        status: 504,
        message: expect.stringContaining('give it longer in Settings → Confluence connection'),
      });
    } finally {
      silent.closeAllConnections();
      await new Promise((resolve) => silent.close(resolve));
    }
  });
});
