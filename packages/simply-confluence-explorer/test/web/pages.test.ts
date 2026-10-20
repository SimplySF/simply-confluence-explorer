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

import { describe, expect, it } from 'vitest';
import { directoryLabel, readingLine, searchPages, type SpacePage } from '../../web/src/support/pages.js';

const page = (title: string, under: string[] = []): SpacePage => ({ id: title, title, path: 'Home', under });

describe('choosing the pages a chat reads', () => {
  it('finds titles that start with what was typed before titles that only contain it', () => {
    const pages = [page('Gateway Runbook'), page('Runbooks'), page('Billing'), page('runbook archive')];
    expect(searchPages(pages, ' runbook ').map((p) => p.title)).toEqual([
      'Runbooks',
      'runbook archive',
      'Gateway Runbook',
    ]);
    expect(searchPages(pages, '')).toEqual([]);
    expect(searchPages(pages, 'b', 1)).toHaveLength(1);
  });

  it('names a directory with how many pages come with it', () => {
    expect(directoryLabel(page('Runbooks', ['a', 'b']))).toBe('Runbooks + 2 sub-pages');
    expect(directoryLabel(page('Runbooks', ['a']))).toBe('Runbooks + 1 sub-page');
  });

  it('says whether each question reads every page or finds sections in them', () => {
    expect(readingLine({ pages: 6, fits: true })).toBe('6 pages: each question reads all of them.');
    expect(readingLine({ pages: 312, fits: false })).toBe(
      '312 pages: each question finds the sections it needs in them.',
    );
    expect(readingLine({ pages: 0, fits: true })).toBe('No pages are chosen yet.');
    expect(readingLine({ pages: 3200, indexing: { done: 1600, total: 3200 } })).toBe(
      'Building the search index: 50% of 3200 pages.',
    );
  });
});
