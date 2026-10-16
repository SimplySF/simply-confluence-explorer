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

// What the server refuses: requests from other websites or for other host names, request values
// that would leave the data directory, bodies a web form could send, and error replies that carry
// internals such as stack traces.

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError, Router } from '../src/http/router.js';
import { createServer } from '../src/server.js';

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-sec-'));

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: string };

// fetch() cleans up dot segments and fills in its own Host header before sending. An attacker's
// client does neither, so these requests go out byte for byte as written.
function raw(
  port: number,
  pathname: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: init.method ?? 'GET',
        headers: { host: `localhost:${port}`, ...init.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

const json = (body: unknown): { method: string; headers: Record<string, string>; body: string } => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const app = (env: NodeJS.ProcessEnv = {}): Promise<number> =>
  listen(createServer({ webRoot: tempDir(), dataDir: tempDir(), env, version: '0.0.0' }));

// A router with routes shaped like the app's, for checking what the router itself enforces.
async function routerApp(log: (message: string) => void = (): void => {}): Promise<number> {
  const router = new Router(log)
    .add('GET', '/api/space-cache/:spaceKey/zip', ({ params }) => params)
    .add('POST', '/api/space-cache/sync', ({ body }) => ({ received: body }))
    .add('GET', '/api/pages/:pageId', ({ params }) => params)
    .add('GET', '/api/boom', () => {
      throw new Error('database exploded');
    })
    .add('GET', '/api/teapot', () => {
      throw new HttpError(418, 'short and stout');
    });
  return listen(http.createServer((req, res) => void router.handle(req, res)));
}

describe('the server', () => {
  it('refuses a browser request sent by another website', async () => {
    const port = await app();
    const res = await raw(port, '/api/health', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a request whose Host names another machine, which is how DNS rebinding arrives', async () => {
    const port = await app();
    expect((await raw(port, '/api/health', { headers: { host: `rebound.evil.example:${port}` } })).status).toBe(403);
    expect((await raw(port, '/api/health', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  });

  it('answers the dev UI on another local port, and a name added with ALLOWED_HOSTS', async () => {
    const local = await app();
    expect((await raw(local, '/api/health', { headers: { origin: 'http://localhost:5173' } })).status).toBe(200);
    const shared = await app({ ALLOWED_HOSTS: 'wiki-tools.corp' });
    const res = await raw(shared, '/api/health', {
      headers: { host: `wiki-tools.corp:${shared}`, origin: `http://wiki-tools.corp:${shared}` },
    });
    expect(res.status).toBe(200);
  });

  it('sends the security headers on API and page responses alike', async () => {
    const port = await app();
    const responses = await Promise.all(
      ['/api/health', '/'].map(async (pathname) => ({ pathname, ...(await raw(port, pathname)) })),
    );
    for (const { pathname, headers } of responses) {
      expect(headers['x-content-type-options'], pathname).toBe('nosniff');
      expect(headers['x-frame-options'], pathname).toBe('DENY');
      expect(headers['content-security-policy'], pathname).toContain("frame-ancestors 'none'");
    }
  });

  it('saves a token through the connection API and never returns it', async () => {
    const port = await app();
    const put = await raw(port, '/api/connection', {
      ...json({ baseUrl: 'https://wiki.example.com', token: 'pat-never-shown' }),
      method: 'PUT',
    });
    expect(put.status).toBe(200);
    const get = await raw(port, '/api/connection');
    expect(get.body).not.toContain('pat-never-shown');
    expect((JSON.parse(get.body) as { tokenSet: boolean }).tokenSet).toBe(true);
    const bad = await raw(port, '/api/connection', { ...json({ baseUrl: 'ftp://x' }), method: 'PUT' });
    expect(bad.status).toBe(400);
  });

  it('refuses a body that is not JSON, because a web form on another site could send it', async () => {
    const port = await app();
    const form = await raw(port, '/api/connection', {
      method: 'PUT',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'baseUrl=https://evil.example',
    });
    expect(form.status).toBe(415);
    const broken = await raw(port, '/api/connection', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(broken.status).toBe(400);
  });

  it('serves the doctor report over the API', async () => {
    const port = await app();
    const report = JSON.parse((await raw(port, '/api/doctor')).body) as { results: unknown[]; ok: boolean };
    expect(report.results.length).toBeGreaterThan(0);
  });
});

describe('the router', () => {
  it('refuses a space key or page id of ".." before a handler can turn it into a path', async () => {
    const port = await routerApp();
    const attempts = [
      '/api/space-cache/%2E%2E/zip',
      '/api/space-cache/..%2F..%2Fconfig/zip',
      '/api/pages/..%2F1',
      '/api/pages/%E0%A4%A',
    ];
    const statuses = await Promise.all(
      attempts.map(async (pathname) => [pathname, (await raw(port, pathname)).status] as const),
    );
    for (const [pathname, status] of statuses) expect(status, pathname).toBe(400);
    expect((await raw(port, '/api/space-cache/ENG/zip')).status).toBe(200);
  });

  it('holds path-shaped fields in bodies and query strings to the same checks', async () => {
    const port = await routerApp();
    expect((await raw(port, '/api/space-cache/sync', json({ spaceKey: '../..' }))).status).toBe(400);
    expect((await raw(port, '/api/space-cache/sync', json({ spaceKey: { toString: 'ENG' } }))).status).toBe(400);
    expect((await raw(port, '/api/space-cache/sync', json({ rootPageId: '12; rm' }))).status).toBe(400);
    expect((await raw(port, '/api/pages/1001?spaceKey=..')).status).toBe(400);
    expect((await raw(port, '/api/space-cache/sync', json({ spaceKey: 'ENG', rootPageId: 1001 }))).status).toBe(200);
  });

  it('answers a failure with a message only, never a stack trace, and logs only server errors', async () => {
    const logged: string[] = [];
    const port = await routerApp((message) => logged.push(message));
    const boom = await raw(port, '/api/boom');
    expect(boom.status).toBe(500);
    expect(JSON.parse(boom.body)).toEqual({ error: 'database exploded' });
    expect(boom.body).not.toMatch(/at .+\.(ts|js):\d+/);
    const teapot = await raw(port, '/api/teapot');
    expect(teapot.status).toBe(418);
    expect(logged).toEqual(['[GET /api/boom] database exploded']);
  });

  it('distinguishes an unknown path from a known path with the wrong method', async () => {
    const port = await routerApp();
    expect((await raw(port, '/api/nope')).status).toBe(404);
    expect((await raw(port, '/api/space-cache/sync')).status).toBe(405);
  });

  it('refuses to register a route whose parameter has no check', () => {
    expect(() => new Router(() => {}).add('GET', '/api/files/:path', () => ({}))).toThrow(/no check/);
  });
});
