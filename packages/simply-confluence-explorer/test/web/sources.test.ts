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
import { readLabel } from '../../web/src/support/sources.js';

const page = (
  id: string,
  sections?: number,
): { id: string; title: string; score: number; sections?: Array<{ index: number; heading: string }> } => ({
  id,
  title: id,
  score: 1,
  ...(sections ? { sections: Array.from({ length: sections }, (_, index) => ({ index, heading: `H${index}` })) } : {}),
});

describe("the line above an answer's sources", () => {
  it('counts the sections retrieved and the pages searched', () => {
    expect(readLabel({ matchedPages: [page('a', 2), page('b', 1)], corpus: { pages: 312, mode: 'retrieved' } })).toBe(
      'Read 3 sections from 2 pages · searched 312 pages',
    );
  });

  it('says when every page was read in full', () => {
    expect(readLabel({ matchedPages: [page('a'), page('b')], corpus: { pages: 2, mode: 'full' } })).toBe(
      'Read all 2 pages',
    );
    expect(readLabel({ matchedPages: [page('a')] })).toBe('Read 1 page');
  });
});
