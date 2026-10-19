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

// The gate a stable release must pass: a second person has approved the pull request that releases
// it (ADR-044).

/* eslint-disable camelcase -- the stand-ins carry GitHub's REST API field names, which are snake case. */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REVIEW_GUIDE,
  approvalProblems,
  lineOf,
  pullRequestBody,
  releaseProblems,
  surfacesOf,
} from '../../../scripts/release-gate.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const agents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');

const pull = {
  number: 7,
  merged_at: '2026-10-19T00:00:00Z',
  user: { login: 'author' },
  head: { ref: 'release/1.0.0', sha: 'last' },
  base: { ref: 'main' },
};
const review = (login: string, state: string, commit_id = 'last') => ({ user: { login }, state, commit_id });

describe('the release pull request', () => {
  const surfaces = surfacesOf(agents);
  const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const source = { repoUrl: 'https://github.com/owner/repo', commit: 'abc123', read };
  const body = pullRequestBody('1.0.0', source);

  it('walks its reviewer through every load-bearing surface in AGENTS.md, in table order', () => {
    expect(surfaces.map((s) => s.surface)).toContain('Writes to Confluence');
    expect(surfaces.map((s) => s.surface)).not.toContain('surface');
    expect(REVIEW_GUIDE.map((area) => area.surface)).toEqual(surfaces.map((s) => s.surface));
  });

  it('links every source file AGENTS.md names for a surface', () => {
    for (const { surface, where } of surfaces) {
      const linked = REVIEW_GUIDE.find((area) => area.surface === surface)?.items.map((item) => item.file) ?? [];
      for (const [, file] of where.matchAll(/`([\w/]+\.ts)`/g)) {
        expect(linked, surface).toContain(`packages/simply-confluence-explorer/src/${file}`);
      }
    }
  });

  it('links only files that exist, at declarations that exist', () => {
    for (const item of REVIEW_GUIDE.flatMap((area) => area.items)) {
      expect(fs.existsSync(path.join(repoRoot, item.file)), item.file).toBe(true);
      if (item.symbol) expect(lineOf(read(item.file), item.symbol), `${item.file} ${item.symbol}`).toBeDefined();
    }
  });

  it('pins every link to the commit being released, and opens it at the declaration to read', () => {
    const links = [...body.matchAll(/\]\((https:[^)]+)\)/g)].map((m) => m[1]);
    const files = links.filter((url) => url.includes('/blob/'));
    expect(files).toHaveLength(REVIEW_GUIDE.flatMap((area) => area.items).length);
    for (const url of files) expect(url).toMatch(/^https:\/\/github\.com\/owner\/repo\/blob\/abc123\//);
    const line = lineOf(read('packages/simply-confluence-explorer/src/confluence/pagePush.ts'), 'writePage');
    expect(body).toContain(`/src/confluence/pagePush.ts#L${line})`);
  });

  it('finds a declaration, and not a call or a mention of it', () => {
    const text = 'call(within);\n// within\nexport function within(base) {}\n';
    expect(lineOf(text, 'within')).toBe(3);
    expect(lineOf(text, 'withinAll')).toBeUndefined();
  });
});

describe('an approval', () => {
  it('allows the release when someone other than the author approved the last commit', () => {
    expect(approvalProblems('1.0.0', pull, [review('reviewer', 'APPROVED')])).toEqual([]);
  });

  it('stops the release when nobody approved it', () => {
    expect(approvalProblems('1.0.0', pull, [review('reviewer', 'COMMENTED')])).toEqual([
      'pull request #7 has no approval of its last commit from anyone but its author',
    ]);
  });

  it('stops the release when the only approval is from its author', () => {
    expect(approvalProblems('1.0.0', pull, [review('author', 'APPROVED')])).toHaveLength(1);
  });

  it('stops the release when the approval was for an earlier commit than the one merged', () => {
    expect(approvalProblems('1.0.0', pull, [review('reviewer', 'APPROVED', 'earlier')])).toHaveLength(1);
  });

  it('stops the release when the approval was dismissed, even though a comment came after it', () => {
    const reviews = [review('reviewer', 'APPROVED'), review('reviewer', 'DISMISSED'), review('reviewer', 'COMMENTED')];
    expect(approvalProblems('1.0.0', pull, reviews)).toHaveLength(1);
  });

  it('stops the release while another reviewer still requests changes', () => {
    const reviews = [review('reviewer', 'APPROVED'), review('other', 'CHANGES_REQUESTED')];
    expect(approvalProblems('1.0.0', pull, reviews)).toEqual(['other requested changes on pull request #7']);
  });

  it('stops the release when the pull request is not from the branch for that version', () => {
    expect(approvalProblems('1.0.1', { ...pull, head: { ...pull.head } }, [review('reviewer', 'APPROVED')])).toEqual([
      'pull request #7 is not from release/1.0.1',
    ]);
  });

  it('refuses a version that is not a plain stable version', () => {
    expect(approvalProblems('1.0.0-beta.0', pull, [review('reviewer', 'APPROVED')])).toEqual([
      '"1.0.0-beta.0" is not a stable version such as 1.0.0',
    ]);
  });
});

describe('the gate for a commit on main', () => {
  /** A stand-in for GitHub's REST API that answers from a fixed table of paths. */
  function github(answers: Record<string, unknown>) {
    return {
      repo: 'owner/repo',
      token: 'token',
      fetch: async (url: string) => {
        const answer = answers[url.replace('https://api.github.com/repos/owner/repo/', '')];
        return new Response(JSON.stringify(answer ?? {}), { status: answer === undefined ? 404 : 200 });
      },
    };
  }

  it('allows a commit that merged an approved release pull request', async () => {
    const api = github({
      'commits/abc/pulls': [pull],
      'pulls/7/reviews?per_page=100&page=1': [review('reviewer', 'APPROVED')],
    });
    expect(await releaseProblems('1.0.0', 'abc', api)).toEqual([]);
  });

  it('stops a commit that did not come from a release pull request, such as a version edited by hand', async () => {
    const api = github({ 'commits/abc/pulls': [{ ...pull, head: { ref: 'feature', sha: 'last' } }] });
    expect(await releaseProblems('1.0.0', 'abc', api)).toEqual([
      'abc is not the merge of a pull request from release/1.0.0 into main',
    ]);
  });

  it('stops a release pull request that was closed without being merged', async () => {
    const api = github({ 'commits/abc/pulls': [{ ...pull, merged_at: null }] });
    expect(await releaseProblems('1.0.0', 'abc', api)).toHaveLength(1);
  });

  it('reads every page of reviews, so a later request for changes is not missed', async () => {
    const approvals = Array.from({ length: 100 }, () => review('reviewer', 'APPROVED'));
    const api = github({
      'commits/abc/pulls': [pull],
      'pulls/7/reviews?per_page=100&page=1': approvals,
      'pulls/7/reviews?per_page=100&page=2': [review('other', 'CHANGES_REQUESTED')],
    });
    expect(await releaseProblems('1.0.0', 'abc', api)).toEqual(['other requested changes on pull request #7']);
  });

  it('fails rather than allows when GitHub cannot be asked', async () => {
    await expect(releaseProblems('1.0.0', 'abc', github({}))).rejects.toThrow('GitHub answered 404');
  });
});
