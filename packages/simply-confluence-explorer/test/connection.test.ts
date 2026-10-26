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

// The server holds the Confluence connection. The token stays on the server, is never sent back to
// a browser, and is never sent to a URL it was not saved for (ADR-019).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectionStore } from '../src/confluence/connection.js';

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-conn-'));
const store = (env: NodeJS.ProcessEnv = {}, dir = tempDir()): ConnectionStore => new ConnectionStore(dir, env);

describe('the connection store', () => {
  it.skipIf(process.platform === 'win32')('stores a token readable only by its owner', () => {
    const dir = tempDir();
    store({}, dir).update({ baseUrl: 'https://wiki.example.com/', token: 'pat-secret-1' });
    expect(fs.statSync(path.join(dir, 'config', 'connection.json')).mode & 0o777).toBe(0o600);
  });

  it('never shows the token in what a browser sees', () => {
    const s = store();
    s.update({ baseUrl: 'https://wiki.example.com/', token: 'pat-secret-1' });
    expect(JSON.stringify(s.publicView())).not.toContain('pat-secret-1');
    expect(s.publicView()).toEqual({
      baseUrl: 'https://wiki.example.com',
      tokenSet: true,
      source: 'settings',
      editable: true,
      profile: '',
      timeoutSeconds: 30,
      timeoutEditable: true,
    });
  });

  it('drops the old token when the URL changes without a new one', () => {
    const s = store();
    s.update({ baseUrl: 'https://a.example.com', token: 't' });
    s.update({ baseUrl: 'https://a.example.com' });
    expect(s.resolve().token, 'same URL: the token is kept').toBe('t');
    s.update({ baseUrl: 'https://b.example.com' });
    expect(s.resolve().token, 'new URL: the old token is not carried over').toBe('');
  });

  it('reuses the saved token for a test connection only when the URL is the saved one', () => {
    const s = store();
    s.update({ baseUrl: 'https://a.example.com', token: 'saved' });
    expect(s.candidate({}).token).toBe('saved');
    expect(s.candidate({ baseUrl: 'https://a.example.com/' }).token).toBe('saved');
    expect(s.candidate({ baseUrl: 'https://evil.example.com' }).token).toBe('');
    expect(s.candidate({ baseUrl: 'https://evil.example.com', token: 'typed' }).token).toBe('typed');
  });

  it("takes the environment's connection, which Settings then cannot change", () => {
    const s = store({ CONFLUENCE_URL: 'http://localhost:8090', CONFLUENCE_PERSONAL_TOKEN: 'env-token' });
    expect(s.resolve()).toEqual({
      baseUrl: 'http://localhost:8090',
      token: 'env-token',
      source: 'env',
      timeoutSeconds: 30,
    });
    expect(s.publicView().editable).toBe(false);
    expect(() => s.update({ baseUrl: 'https://other.example.com' })).toThrow(/server environment/);
    expect(() => s.update({ token: 'other' })).toThrow(/server environment/);
  });

  it('gives Confluence the time limit set in Settings or the environment, where 30 seconds was fixed', () => {
    const s = store();
    s.update({ timeoutSeconds: 120 });
    expect(s.resolve().timeoutSeconds).toBe(120);
    expect(s.candidate({}).timeoutSeconds).toBe(120);
    for (const bad of [4, 601, 1.5]) expect(() => s.update({ timeoutSeconds: bad })).toThrow(/whole number of seconds/);
    const env = store({ CONFLUENCE_URL: 'http://localhost:8090', CONFLUENCE_TIMEOUT_SECONDS: '90' });
    expect(env.publicView()).toMatchObject({ timeoutSeconds: 90, timeoutEditable: false });
    env.update({ timeoutSeconds: 200 });
    expect(env.resolve().timeoutSeconds, 'the environment wins').toBe(90);
  });

  it('refuses a URL that is not http or https', () => {
    expect(() => store().update({ baseUrl: 'file:///etc/passwd' })).toThrow(/http/);
  });
});
