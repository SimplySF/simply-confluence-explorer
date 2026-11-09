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

// A large corpus is searched so that no single directory or series fills the candidates, and by a
// plan over a map of its directories (ADR-079, design doc 0017).

import { describe, expect, it } from 'vitest';
import { diversify } from '../src/spaces/contextRetriever.js';

describe('the diversity cap', () => {
  const group = (id: string): string[] => [`dir:${id.split('-')[0]}`];

  it('lets no directory take more than 8 of 40 candidates when others matched', () => {
    const notes = Array.from({ length: 100 }, (_, i) => `notes-${i}`);
    const others = Array.from({ length: 4 }, (_, i) => [`identity-${i}`, `payments-${i}`, `people-${i}`]).flat();
    const ranked = diversify([[...notes, ...others]], 40, group);
    expect(ranked).toEqual([...notes.slice(0, 8), ...others]);
  });

  it('still offers a full list from a corpus of one directory', () => {
    const notes = Array.from({ length: 100 }, (_, i) => `notes-${i}`);
    expect(diversify([notes], 40, group)).toEqual(notes.slice(0, 40));
  });

  it('takes from each ranking in turn, so every ranking contributes', () => {
    const a = Array.from({ length: 5 }, (_, i) => `a${i}-x`);
    const b = Array.from({ length: 5 }, (_, i) => `b${i}-x`);
    expect(diversify([a, ['c-1'], b], 6, (id) => [id])).toEqual(['a0-x', 'c-1', 'b0-x', 'a1-x', 'b1-x', 'a2-x']);
  });
});
