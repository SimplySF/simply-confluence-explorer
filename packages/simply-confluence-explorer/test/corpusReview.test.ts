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

// Reviews of more pages than one request carries, read in batches of related pages (ADR-051).

import { describe, expect, it } from 'vitest';
import type { BranchFinding } from '../src/api/types.js';
import { areaOf, batchPages, mergeFindings, type BatchPage } from '../src/branches/corpusReview.js';

const page = (id: string, size: number, topics: string[] = [], parent?: string): BatchPage => ({
  id,
  size,
  topics,
  parent,
});

describe('packing pages into batches', () => {
  it('puts pages that share a topic in one batch when they fit, wherever they sit', () => {
    const pages = [
      page('git-a', 40, ['source-control'], 'devops'),
      page('billing', 60, ['payments'], 'services'),
      page('git-b', 40, ['source-control'], 'projects'),
      page('auth', 60, ['identity'], 'services'),
    ];
    const batches = batchPages(pages, 100);
    expect(batches.find((b) => b.includes('git-a'))).toContain('git-b');
    expect(batches.flat().sort()).toEqual(['auth', 'billing', 'git-a', 'git-b']);
    expect(batches.every((b) => b.reduce((n, id) => n + pages.find((p) => p.id === id)!.size, 0) <= 100)).toBe(true);
  });

  it('groups pages with no shared topic by their directory, and splits a group too large for one batch', () => {
    const pages = [page('a', 50, [], 'x'), page('b', 50, [], 'y'), page('c', 50, [], 'x'), page('d', 50, [], 'x')];
    const batches = batchPages(pages, 100);
    // The group of three is split; the last of it shares a batch with the next directory's page.
    expect(batches).toEqual([
      ['a', 'c'],
      ['d', 'b'],
    ]);
  });

  it('compares the pages of one area together even when their tags differ, topic by topic', () => {
    const inArea = (id: string, topics: string[], area: string): BatchPage => ({ ...page(id, 30, topics), area });
    const pages = [
      inArea('refunds', ['refunds'], 'payments'),
      inArea('login', ['auth'], 'identity'),
      inArea('payouts', ['money'], 'payments'),
      inArea('returns', ['refunds'], 'payments'),
      inArea('keys', ['auth'], 'identity'),
    ];
    expect(batchPages(pages, 100)).toEqual([
      ['refunds', 'returns', 'payouts'],
      ['login', 'keys'],
    ]);
  });

  it('places a page in the area one level below the corpus top, or in its nearest directory', () => {
    const at = (id: string, ...ids: string[]) => ({ id, ancestors: ids.map((a) => ({ id: a, title: a })) });
    expect(areaOf(at('deep', 'space', 'eng', 'payments', 'refunds'), 1)).toBe('payments');
    expect(areaOf(at('payments', 'space', 'eng'), 1)).toBe('payments');
    expect(areaOf(at('eng', 'space'), 1)).toBe('space');
  });

  it('starts a new batch for a group that would fit one alone, rather than splitting it', () => {
    const pages = [page('one', 70, [], 'p'), page('t1', 30, ['t']), page('t2', 30, ['t'])];
    expect(batchPages(pages, 100)).toEqual([['one'], ['t1', 't2']]);
  });
});

describe('merging the findings of several batches', () => {
  it('says each finding once', () => {
    const f: BranchFinding = {
      kind: 'redundant',
      pages: ['A', 'B'],
      detail: 'Same steps twice.',
      suggestion: 'Keep one.',
    };
    const merged = mergeFindings([
      [f],
      [{ ...f, pages: ['B', 'A'], detail: ' same steps twice. ' }],
      [{ ...f, kind: 'stale' as const }],
    ]);
    expect(merged.map((m) => m.kind)).toEqual(['redundant', 'stale']);
  });
});
