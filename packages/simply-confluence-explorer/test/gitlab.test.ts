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

// Reading GitLab for new pages (ADR-050): only the configured GitLab, never the token to a browser,
// within fixed limits, and nothing else in the server talks to the network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitLabClient, GitLabStore, parseRepoLink, REPO_FILE_LIMIT } from '../src/gitlab/client.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { GITLAB_PROJECT, GITLAB_TOKEN, startFakeGitLab, type FakeGitLab } from './support/fakeGitLab.js';
import { startTestApp } from './support/testApp.js';

let gitlab: FakeGitLab;
let fake: FakeConfluence;
beforeAll(async () => {
  gitlab = await startFakeGitLab();
  fake = await startFakeConfluence();
});
afterAll(async () => {
  await gitlab.close();
  await fake.close();
});

const repo = (): string => `${gitlab.url}/${GITLAB_PROJECT}`;

describe('a link to a repository', () => {
  it('is read only on the configured GitLab, with its branch when it names one', () => {
    expect(parseRepoLink('https://gitlab.example.test/group/team/service', 'https://gitlab.example.test')).toEqual({
      project: 'group/team/service',
    });
    expect(parseRepoLink('https://gitlab.example.test/group/service.git', 'https://gitlab.example.test/')).toEqual({
      project: 'group/service',
    });
    expect(
      parseRepoLink('https://gitlab.example.test/group/service/-/tree/release%2F2', 'https://gitlab.example.test'),
    ).toEqual({ project: 'group/service', ref: 'release/2' });
    expect(() => parseRepoLink('https://evil.example.test/group/service', 'https://gitlab.example.test')).toThrow(
      /Only repositories on the configured GitLab/,
    );
    expect(() => parseRepoLink('http://gitlab.example.test/group/service', 'https://gitlab.example.test')).toThrow();
    expect(() => parseRepoLink('https://gitlab.example.test/service', 'https://gitlab.example.test')).toThrow();
    expect(() => parseRepoLink('not a link', 'https://gitlab.example.test')).toThrow();
  });
});

describe('reading a repository', () => {
  it('reads its README, docs, API description and manifest, and not its code', async () => {
    const digest = await new GitLabClient({ baseUrl: gitlab.url, token: GITLAB_TOKEN }).readRepository(repo());
    expect(digest.files.sort()).toEqual(['README.md', 'api/openapi.yaml', 'docs/architecture.md', 'package.json']);
    expect(digest.text).toContain('Charges customers each month.');
    expect(digest.text).toContain('src/index.ts');
    expect(digest.text).not.toContain('secretSauce');
  });

  it(`stops at ${REPO_FILE_LIMIT} files and a fixed number of characters`, async () => {
    const extra = new Map(gitlab.files);
    for (let i = 0; i < 60; i++) gitlab.files.set(`docs/page-${i}.md`, 'x'.repeat(10_000));
    try {
      const digest = await new GitLabClient({ baseUrl: gitlab.url, token: GITLAB_TOKEN }).readRepository(repo());
      expect(digest.files.length).toBeLessThanOrEqual(REPO_FILE_LIMIT);
      expect(digest.text.length).toBeLessThan(210_000);
    } finally {
      gitlab.files.clear();
      for (const [k, v] of extra) gitlab.files.set(k, v);
    }
  });

  it('reports a wrong token, or a repository it cannot see, in words a person can act on', async () => {
    await expect(new GitLabClient({ baseUrl: gitlab.url, token: 'wrong' }).test()).rejects.toThrow(/refused the token/);
    await expect(
      new GitLabClient({ baseUrl: gitlab.url, token: GITLAB_TOKEN }).readRepository(`${gitlab.url}/nobody/nothing`),
    ).rejects.toThrow(/did not find that repository/);
    await expect(new GitLabClient({ baseUrl: '', token: '' }).test()).rejects.toThrow(/not set up/);
  });
});

describe('the GitLab connection', () => {
  it('keeps its token on the server, and drops it when the address changes', async () => {
    const app = await startTestApp(fake);
    try {
      const saved = await app.call<Record<string, unknown>>('PUT', '/gitlab', {
        baseUrl: gitlab.url,
        token: GITLAB_TOKEN,
      });
      expect(saved.body).toEqual({ baseUrl: gitlab.url, tokenSet: true });
      expect(JSON.stringify((await app.call('GET', '/gitlab')).body)).not.toContain(GITLAB_TOKEN);
      const tested = await app.call<{ ok: boolean; user?: { username: string } }>('POST', '/gitlab/test', {});
      expect(tested.body).toEqual({ ok: true, user: { username: 'tech.lead', name: 'Tech Lead' } });
      // A different address typed into Settings is never sent the saved token.
      const before = gitlab.requests.length;
      const elsewhere = await app.call<{ ok: boolean }>('POST', '/gitlab/test', { baseUrl: `${gitlab.url}/other` });
      expect(elsewhere.body.ok).toBe(false);
      expect(gitlab.requests.slice(before).every((r) => r.token !== GITLAB_TOKEN)).toBe(true);
      expect((await app.call('PUT', '/gitlab', { baseUrl: 'ftp://x' })).status).toBe(400);
      expect((await app.call('PUT', '/gitlab', { baseUrl: `${gitlab.url}/` })).body).toEqual({
        baseUrl: gitlab.url,
        tokenSet: true,
      });
      expect((await app.call('PUT', '/gitlab', { baseUrl: 'https://gitlab.example.test' })).body).toEqual({
        baseUrl: 'https://gitlab.example.test',
        tokenSet: false,
      });
      const file = path.join(app.dataDir, 'config', 'gitlab.json');
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('is the only module besides the Confluence client that reaches the network', () => {
    const src = path.join(import.meta.dirname, '../src');
    const callers = (fs.readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /(?<![\w-])fetch\s*\(|typeof fetch|=\s*fetch\b/.test(fs.readFileSync(path.join(src, f), 'utf8')))
      .map((f) => f.split(path.sep).join('/'))
      .sort();
    expect(callers).toEqual(['confluence/client.ts', 'gitlab/client.ts']);
  });

  it('stores nothing until it is saved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-gitlab-'));
    expect(new GitLabStore(dir).publicView()).toEqual({ baseUrl: '', tokenSet: false });
  });
});
