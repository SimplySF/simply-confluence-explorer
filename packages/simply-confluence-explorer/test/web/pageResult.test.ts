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
import { forPage, newest } from '../../web/src/support/pageResult.js';

describe('a result about a page', () => {
  it('is not shown on another page that was opened while it was on its way', () => {
    let onScreen = 'page-1';
    const shown: string[] = [];
    const show = forPage(
      'page-1',
      () => onScreen,
      (v: string) => shown.push(v),
    );
    onScreen = 'page-2';
    show('summary of page 1');
    expect(shown).toEqual([]);
  });

  it('is shown while its page is still the one on screen', () => {
    const shown: string[] = [];
    forPage(
      'page-1',
      () => 'page-1',
      (v: string) => shown.push(v),
    )('summary of page 1');
    expect(shown).toEqual(['summary of page 1']);
  });
});

describe('overlapping requests for the same list', () => {
  it('a slower, older tags answer does not replace a newer one', () => {
    const request = newest();
    let tags: string[] = [];
    const older = request()((t: string[]) => (tags = t));
    const newer = request()((t: string[]) => (tags = t));
    newer(['ops', 'deploy']);
    older([]);
    expect(tags).toEqual(['ops', 'deploy']);
  });
});
