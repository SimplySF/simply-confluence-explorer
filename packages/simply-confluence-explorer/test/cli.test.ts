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

import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HOST, main, USAGE } from '../src/cli.js';

// Every test names its own data directory, so none of them reads or writes the real one.
const dataDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-cli-'));

describe('main', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it('prints usage for --help without starting a server', async () => {
    const log = vi.fn();
    expect(await main({ argv: ['--help'], env: {}, log })).toBeUndefined();
    expect(log).toHaveBeenCalledWith(USAGE);
  });

  it('binds to localhost by default and logs the URL', async () => {
    const log = vi.fn();
    server = await main({ argv: ['--port', '0', '--data-dir', dataDir()], env: {}, log });
    const address = server!.address() as AddressInfo;
    expect(address.address).toBe(DEFAULT_HOST);
    expect(log).toHaveBeenCalledWith(`Confluence Explorer is running at http://127.0.0.1:${address.port}/`);
  });

  it('takes the port from PORT when no flag is given', async () => {
    server = await main({ argv: ['--data-dir', dataDir()], env: { PORT: '0' } });
    expect((server!.address() as AddressInfo).port).toBeGreaterThan(0);
  });

  it('rejects a port that is not a valid integer', async () => {
    await expect(main({ argv: ['--port', 'abc'], env: {} })).rejects.toThrow('Invalid port "abc"');
  });

  it('rejects unknown flags', async () => {
    await expect(main({ argv: ['--nope'], env: {} })).rejects.toThrow();
  });

  it('rejects an unknown command instead of starting the server', async () => {
    await expect(main({ argv: ['serve-everything'], env: {} })).rejects.toThrow(/Unknown command/);
  });

  it('runs the doctor instead of the server, and reads the connection from the data directory .env', async () => {
    const dir = dataDir();
    fs.writeFileSync(
      path.join(dir, '.env'),
      'CONFLUENCE_URL=https://wiki.example.com\nCONFLUENCE_PERSONAL_TOKEN=pat\n',
    );
    const log = vi.fn();
    expect(await main({ argv: ['doctor', '--json', '--data-dir', dir], env: {}, log })).toBeUndefined();
    const report = JSON.parse(log.mock.calls[0][0] as string) as { results: Array<{ id: string; summary: string }> };
    expect(report.results.find((r) => r.id === 'confluence-config')?.summary).toBe(
      'Confluence at https://wiki.example.com',
    );
  });

  it('lets the real environment win over the data directory .env', async () => {
    const dir = dataDir();
    fs.writeFileSync(path.join(dir, '.env'), 'CONFLUENCE_URL=https://from-file.example.com\n');
    const log = vi.fn();
    await main({
      argv: ['doctor', '--json', '--data-dir', dir],
      env: { CONFLUENCE_URL: 'https://from-env.example.com', CONFLUENCE_PERSONAL_TOKEN: 't' },
      log,
    });
    expect(log.mock.calls[0][0]).toContain('from-env.example.com');
  });

  it('exits non-zero from the doctor when a check fails', async () => {
    const dir = dataDir();
    fs.writeFileSync(
      path.join(dir, '.env'),
      'CONFLUENCE_URL=https://acme.atlassian.net\nCONFLUENCE_PERSONAL_TOKEN=t\n',
    );
    await expect(main({ argv: ['doctor', '--data-dir', dir], env: {} })).rejects.toThrow(/doctor found a problem/);
  });
});
