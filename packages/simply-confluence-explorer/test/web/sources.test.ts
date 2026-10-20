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
import { readLabel, sentLines } from '../../web/src/support/sources.js';

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

  it('says when every page was read over several requests', () => {
    expect(readLabel({ corpus: { pages: 312, mode: 'batched', batches: 9 } })).toBe('Read all 312 pages in 9 batches');
    expect(readLabel({ corpus: { pages: 3, mode: 'batched', batches: 1 } })).toBe('Read all 3 pages in 1 batch');
  });
});

describe('what an answer sent', () => {
  it('counts what went to the model and says why anything stayed behind, never naming an excluded page', () => {
    const lines = sentLines({
      pages: 0,
      sections: 12,
      files: 1,
      turns: 3,
      chars: 41200,
      leftOut: [
        { kind: 'page', label: 'Deploy Notes', reason: 'secret' },
        { kind: 'page', label: '', reason: 'excluded' },
        { kind: 'page', label: '', reason: 'excluded' },
      ],
    });
    expect(lines).toEqual({
      summary: 'Sent 12 sections, 1 file, 3 earlier messages · 41,200 characters',
      leftOut: ['Deploy Notes: holds a secret', "2 pages: excluded by the space's rules"],
    });
  });
});
