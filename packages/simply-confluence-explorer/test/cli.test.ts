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

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HOST, main, USAGE } from '../src/cli.js';

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
    server = await main({ argv: ['--port', '0'], env: {}, log });
    const address = server!.address() as AddressInfo;
    expect(address.address).toBe(DEFAULT_HOST);
    expect(log).toHaveBeenCalledWith(`Confluence Explorer is running at http://127.0.0.1:${address.port}/`);
  });

  it('takes the port from PORT when no flag is given', async () => {
    server = await main({ argv: [], env: { PORT: '0' } });
    expect((server!.address() as AddressInfo).port).toBeGreaterThan(0);
  });

  it('rejects a port that is not a valid integer', async () => {
    await expect(main({ argv: ['--port', 'abc'], env: {} })).rejects.toThrow('Invalid port "abc"');
  });

  it('rejects unknown flags', async () => {
    await expect(main({ argv: ['--nope'], env: {} })).rejects.toThrow();
  });
});
