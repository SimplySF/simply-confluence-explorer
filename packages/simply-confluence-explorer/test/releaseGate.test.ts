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
import { approvalProblems, pullRequestBody, releaseProblems, surfacesOf } from '../../../scripts/release-gate.mjs';

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
  it('lists every load-bearing surface in AGENTS.md for its reviewer', () => {
    const surfaces = surfacesOf(agents);
    expect(surfaces).toContain('Writes to Confluence');
    expect(surfaces).toContain('The enforcement itself');
    expect(surfaces).not.toContain('surface');
    const body = pullRequestBody('1.0.0', agents);
    for (const surface of surfaces) expect(body).toContain(`| ${surface} `);
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
