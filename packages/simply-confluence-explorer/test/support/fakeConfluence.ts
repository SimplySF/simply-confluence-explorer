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

// A stand-in for Confluence Data Center, for the fast suite. It serves the same test dataset the
// test environment seeds (ADR-007), over HTTP and in the REST shapes the real server uses, so the
// tests go through the same client code as production. The end-to-end suite runs the real thing.

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { ignoreFiles, spaces, type DatasetPage } from '../../../../test-env/fixtures/dataset.mjs';

export const FAKE_TOKEN = 'fake-confluence-token';
export const FAKE_USER = { username: 'admin', userKey: 'admin-user-key', displayName: 'Test Admin' };

export type FakePage = {
  id: string;
  title: string;
  spaceKey: string;
  storage: string;
  labels: string[];
  attachments: Array<{ title: string; content: Buffer; type: string }>;
  ancestors: Array<{ id: string; title: string }>;
  children: string[];
  version: number;
};

export type FakeConfluence = {
  url: string;
  /** Every request received, as method and path with query, for tests that check what was asked. */
  requests: string[];
  /** The tokens the fake was sent, so a test can check a token never went where it should not. */
  tokens: string[];
  pages: Map<string, FakePage>;
  /** The ids of the pages written, in order. */
  writes: string[];
  /** The page with this title in this space. */
  page: (spaceKey: string, title: string) => FakePage;
  /** Writes each space's `.confluenceignore` into a data directory, as the seed does. */
  writeIgnoreFiles: (dataDir: string) => void;
  close: () => Promise<void>;
};

/** Children per page of results, kept small so the tests exercise the client's paging. */
const PAGE_SIZE = 3;

function indexDataset(): Map<string, FakePage> {
  const pages = new Map<string, FakePage>();
  let nextId = 1000;
  const add = (spaceKey: string, node: DatasetPage, ancestors: FakePage['ancestors']): FakePage => {
    const id = String(nextId++);
    const storage = typeof node.body === 'function' ? node.body({ userKey: FAKE_USER.userKey }) : (node.body ?? '');
    const page: FakePage = {
      id,
      title: node.title,
      spaceKey,
      storage,
      labels: node.labels ?? [],
      attachments: (node.attachments ?? []).map((a) => ({ title: a.filename, content: a.content, type: a.type })),
      ancestors,
      children: [],
      version: 1,
    };
    pages.set(id, page);
    page.children = (node.children ?? []).map(
      (child) => add(spaceKey, child, [...ancestors, { id, title: node.title }]).id,
    );
    return page;
  };
  for (const space of spaces)
    add(space.key, { title: `${space.name} Home`, body: space.home, children: space.pages }, []);
  return pages;
}

const ATTACHMENTS_EXPANDED = 25;

function restAttachment(page: FakePage, a: FakePage['attachments'][number], i: number): Record<string, unknown> {
  return {
    id: `att${page.id}${i}`,
    title: a.title,
    metadata: { mediaType: a.type },
    extensions: { fileSize: a.content.length },
    _links: { download: `/download/attachments/${page.id}/${encodeURIComponent(a.title)}` },
  };
}

function rest(page: FakePage): Record<string, unknown> {
  return {
    id: page.id,
    type: 'page',
    title: page.title,
    space: { key: page.spaceKey },
    version: { number: page.version, when: '2026-01-01T00:00:00.000Z', by: { displayName: FAKE_USER.displayName } },
    ancestors: page.ancestors,
    body: { storage: { value: page.storage, representation: 'storage' } },
    metadata: { labels: { results: page.labels.map((name) => ({ name })) } },
    // As Confluence does, an expanded list holds the first 25, and names where the rest are.
    children: {
      attachment: {
        results: page.attachments.slice(0, ATTACHMENTS_EXPANDED).map((a, i) => restAttachment(page, a, i)),
        _links:
          page.attachments.length > ATTACHMENTS_EXPANDED
            ? { next: `/rest/api/content/${page.id}/child/attachment` }
            : {},
      },
    },
    _links: { webui: `/pages/viewpage.action?pageId=${page.id}` },
  };
}

export async function startFakeConfluence(): Promise<FakeConfluence> {
  const pages = indexDataset();
  const requests: string[] = [];
  const tokens: string[] = [];
  const writes: string[] = [];
  const homes = new Map(spaces.map((s) => [s.key, [...pages.values()].find((p) => p.spaceKey === s.key)!]));

  const written = new WeakMap<http.IncomingMessage, unknown>();
  const server = http.createServer((incoming, response) => {
    let raw = '';
    incoming.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    incoming.on('end', () => {
      written.set(incoming, raw ? (JSON.parse(raw) as unknown) : {});
      handle(incoming, response);
    });
  });
  // Like Confluence, a write must name the next version, which refuses one made from a stale read.
  const update = (id: string, change: unknown): [number, unknown] => {
    const page = pages.get(id);
    if (!page) return [404, { message: `No content found with id: ${id}` }];
    const c = change as { title?: string; version?: { number?: number }; body?: { storage?: { value?: string } } };
    if (c.version?.number !== page.version + 1) {
      return [409, { message: `Version must be incremented on update. Current version is: ${page.version}` }];
    }
    page.version++;
    page.title = c.title ?? page.title;
    page.storage = c.body?.storage?.value ?? page.storage;
    writes.push(page.id);
    return [200, rest(page)];
  };
  // Like Confluence, one page per title in a space, and a new page goes under the parent it names.
  const create = (change: unknown): [number, unknown] => {
    const c = change as {
      title?: string;
      space?: { key?: string };
      ancestors?: Array<{ id?: string }>;
      body?: { storage?: { value?: string } };
    };
    const spaceKey = c.space?.key ?? '';
    if ([...pages.values()].some((p) => p.spaceKey === spaceKey && p.title === c.title)) {
      return [
        400,
        { message: 'A page with this title already exists: A page already exists with the same TITLE in this space' },
      ];
    }
    const parent = pages.get(c.ancestors?.at(-1)?.id ?? '');
    const id = String(Math.max(...[...pages.keys()].map(Number)) + 1);
    const page: FakePage = {
      id,
      title: c.title ?? '',
      spaceKey,
      storage: c.body?.storage?.value ?? '',
      labels: [],
      attachments: [],
      ancestors: parent ? [...parent.ancestors, { id: parent.id, title: parent.title }] : [],
      children: [],
      version: 1,
    };
    pages.set(id, page);
    parent?.children.push(id);
    writes.push(id);
    return [200, rest(page)];
  };

  // Enough of CQL for the app's search: space = "KEY" and any of the text ~ "word" terms.
  const search = (cql: string): unknown[] => {
    const space = /space = "([^"]+)"/.exec(cql)?.[1];
    const words = [...cql.matchAll(/text ~ "([^"]+)"/g)].map((w) => w[1].toLowerCase());
    return [...pages.values()]
      .filter((p) => p.spaceKey === space && words.some((w) => `${p.title} ${p.storage}`.toLowerCase().includes(w)))
      .map((p) => ({ content: { id: p.id, title: p.title }, excerpt: `@@@hl@@@${p.title}@@@endhl@@@ excerpt` }));
  };

  /** Answers a page's attachment list and an attachment's download; false for any other route. */
  const attachmentRoute = (
    route: string,
    res: http.ServerResponse,
    list: (all: unknown[]) => void,
    json: (status: number, body: unknown) => void,
  ): boolean => {
    let match = /^\/rest\/api\/content\/(\d+)\/child\/attachment$/.exec(route);
    if (match) {
      const page = pages.get(match[1]);
      if (page) list(page.attachments.map((a, i) => restAttachment(page, a, i)));
      else json(404, { message: 'No content found' });
      return true;
    }
    match = /^\/download\/attachments\/(\d+)\/(.+)$/.exec(route);
    if (!match) return false;
    const title = decodeURIComponent(match[2]);
    const found = pages.get(match[1])?.attachments.find((a) => a.title === title);
    if (found) res.writeHead(200, { 'content-type': found.type }).end(found.content);
    else json(404, { message: 'No attachment' });
    return true;
  };

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://fake');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    tokens.push((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    const list = (all: unknown[]): void => {
      const start = Number(url.searchParams.get('start') ?? 0);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? PAGE_SIZE), PAGE_SIZE);
      const results = all.slice(start, start + limit);
      const more = start + results.length < all.length;
      json(200, {
        results,
        start,
        limit,
        size: results.length,
        _links: more ? { next: `next?start=${start + limit}` } : {},
      });
    };
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      json(401, { message: 'Authentication failed' });
      return;
    }
    const route = url.pathname;
    let match: RegExpExecArray | null;
    if (route === '/rest/api/user/current') return json(200, FAKE_USER);
    if (route === '/rest/license/1.0/license/details')
      return json(200, { expired: false, expiryDate: Date.now() + 2 * 3_600_000 });
    const space = (key: string): Record<string, unknown> | undefined => {
      const s = spaces.find((x) => x.key === key);
      return (
        s && {
          key: s.key,
          name: s.name,
          type: 'global',
          description: { plain: { value: s.description } },
          homepage: { id: homes.get(s.key)!.id, title: homes.get(s.key)!.title },
          _links: { webui: `/display/${s.key}` },
        }
      );
    };
    if (route === '/rest/api/space') return list(spaces.map((s) => space(s.key)));
    if ((match = /^\/rest\/api\/space\/([^/]+)$/.exec(route))) {
      const found = space(decodeURIComponent(match[1]));
      return found ? json(200, found) : json(404, { message: `No space with key : ${match[1]}` });
    }
    if (route === '/rest/api/search') return list(search(url.searchParams.get('cql') ?? ''));
    if (route === '/rest/api/content') {
      if (req.method === 'POST') return json(...create(written.get(req)));
      return list([...pages.values()].filter((p) => p.spaceKey === url.searchParams.get('spaceKey')).map(rest));
    }
    if ((match = /^\/rest\/api\/content\/(\d+)\/child\/page$/.exec(route))) {
      const page = pages.get(match[1]);
      return page ? list(page.children.map((id) => rest(pages.get(id)!))) : json(404, { message: 'No content found' });
    }
    if ((match = /^\/rest\/api\/content\/(\d+)$/.exec(route))) {
      if (req.method === 'PUT') return json(...update(match[1], written.get(req)));
      const page = pages.get(match[1]);
      return page ? json(200, rest(page)) : json(404, { message: `No content found with id: ${match[1]}` });
    }
    if (attachmentRoute(route, res, list, json)) return;

    json(404, { message: `No route for ${route}` });
  };

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const page = (spaceKey: string, title: string): FakePage => {
    const found = [...pages.values()].find((p) => p.spaceKey === spaceKey && p.title === title);
    if (!found) throw new Error(`the dataset has no page "${title}" in ${spaceKey}`);
    return found;
  };
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    tokens,
    writes,
    pages,
    page,
    writeIgnoreFiles: (dataDir) => {
      for (const [spaceKey, lines] of Object.entries(ignoreFiles)) {
        const dir = path.join(dataDir, 'spaces', spaceKey);
        fs.mkdirSync(dir, { recursive: true });
        const resolved = lines.map((line) =>
          line.replace(/\{\{id:([^}]+)\}\}/g, (_, title: string) => page(spaceKey, title).id),
        );
        fs.writeFileSync(path.join(dir, '.confluenceignore'), `${resolved.join('\n')}\n`);
      }
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
