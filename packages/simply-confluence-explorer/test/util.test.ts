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

// The helpers every path and private file goes through, and where the app keeps its data.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataDir } from '../src/util/dataDir.js';
import { sanitizeFilename, within } from '../src/util/paths.js';
import { readJsonOrEmpty, writePrivateJson } from '../src/util/privateFile.js';

describe('path helpers', () => {
  it('turn a name made of dots into "_", so a page titled ".." cannot name a parent directory', () => {
    expect(sanitizeFilename('..')).toBe('_');
    expect(sanitizeFilename('.')).toBe('_');
    expect(sanitizeFilename('../etc')).toBe('.._etc');
    expect(sanitizeFilename('  ')).toBe('untitled');
  });

  it('refuse to leave their directory even when a caller forgot to validate', () => {
    const base = path.resolve('/data/spaces');
    expect(() => within(base, '..')).toThrow(/escapes/);
    expect(() => within(base, 'ENG', '../../x')).toThrow(/escapes/);
    expect(within(base, 'ENG')).toBe(path.join(base, 'ENG'));
  });
});

describe('the data directory', () => {
  it('comes from the flag, then the environment, then the home directory', () => {
    const home = path.resolve('/home/someone');
    const env = { CONFLUENCE_EXPLORER_DATA: path.resolve('/from-env') };
    expect(resolveDataDir(path.resolve('/from-flag'), env, home)).toBe(path.resolve('/from-flag'));
    expect(resolveDataDir(undefined, env, home)).toBe(path.resolve('/from-env'));
    expect(resolveDataDir(undefined, {}, home)).toBe(path.join(home, '.confluence-explorer'));
  });
});

describe('private files', () => {
  it.skipIf(process.platform === 'win32')('are written with mode 0600 in a 0700 directory', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-priv-')), 'config', 'secret.json');
    writePrivateJson(file, { token: 't' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('read as empty when missing, and as an error when damaged rather than as an empty config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-priv-'));
    expect(readJsonOrEmpty(path.join(dir, 'missing.json'))).toEqual({});
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    expect(() => readJsonOrEmpty(path.join(dir, 'broken.json'))).toThrow();
  });
});
