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

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

describe('createServer', () => {
  let webRoot: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    webRoot = await mkdtemp(path.join(os.tmpdir(), 'confluence-explorer-'));
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>index</title>');
    await mkdir(path.join(webRoot, 'assets'));
    await writeFile(path.join(webRoot, 'assets', 'app.js'), 'console.log("app");');

    server = createServer({ webRoot, version: '1.2.3', dataDir: path.join(webRoot, 'data'), env: {} });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(webRoot, { recursive: true, force: true });
  });

  it('reports health with the configured version', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ status: 'ok', version: '1.2.3' });
  });

  it('returns a JSON 404 for unknown API routes instead of the app shell', async () => {
    const res = await fetch(`${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No API route for GET /api/nope' });
  });

  it('serves built assets with their content type', async () => {
    const res = await fetch(`${baseUrl}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(await res.text()).toBe('console.log("app");');
  });

  it('serves index.html for the root and for client-side routes', async () => {
    for (const route of ['/', '/spaces/ENG/pages/123']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${baseUrl}${route}`);
      expect(res.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      expect(await res.text()).toContain('<title>index</title>');
    }
  });

  it('never serves files outside the web root', async () => {
    await writeFile(path.join(path.dirname(webRoot), 'secret.txt'), 'secret');
    try {
      const res = await fetch(`${baseUrl}/%2e%2e/secret.txt`);
      expect(await res.text()).not.toContain('secret');
    } finally {
      await rm(path.join(path.dirname(webRoot), 'secret.txt'), { force: true });
    }
  });

  it('rejects writes to static paths', async () => {
    const res = await fetch(`${baseUrl}/`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('explains how to build when the web bundle is missing', async () => {
    await rm(webRoot, { recursive: true, force: true });
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('pnpm run build');
  });
});
