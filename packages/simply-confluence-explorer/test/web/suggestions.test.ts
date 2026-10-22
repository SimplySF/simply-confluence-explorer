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
import { canEdit, editNote, handNote } from '../../web/src/support/suggestions.js';

describe('a suggestion in the review queue', () => {
  it('says why it has no checkbox when it names only pages the chat did not read, where it said nothing', () => {
    const s = { kind: 'clarity' as const, pages: ['Offers'], pageIds: {} };
    expect(canEdit(s)).toBe(false);
    expect(editNote(s)).toContain('“Offers”');
  });

  it('can be ticked when it names a page the chat read, and names any page it did not', () => {
    const s = { kind: 'clarity' as const, pages: ['Interviews', 'Offers'], pageIds: { Interviews: '1' } };
    expect(canEdit(s)).toBe(true);
    expect(editNote(s)).toBe('“Offers” was not read by this chat, so only the other pages are edited.');
    expect(editNote({ ...s, pages: ['Interviews'] })).toBeUndefined();
  });

  it('cannot be ticked when no edit of a page can carry it out, and says so', () => {
    for (const kind of ['gap', 'placement'] as const) {
      expect(canEdit({ kind, pages: ['Interviews'], pageIds: { Interviews: '1' } })).toBe(false);
      expect(editNote({ kind, pages: [], pageIds: {} })).toMatch(/new page|moved/);
    }
  });

  it('cannot be ticked when it is all work for a person, and says what that work is', () => {
    const s = {
      kind: 'stale' as const,
      pages: ['Interviews'],
      pageIds: { Interviews: '1' },
      byHand: 'Redraw loop.png.',
      byHandOnly: true,
    };
    expect(canEdit(s)).toBe(false);
    expect(editNote(s)).toBe('The AI cannot make this change: Redraw loop.png. Change it in Confluence.');
    expect(handNote(s)).toBeUndefined();
    const part = { ...s, byHandOnly: undefined };
    expect(canEdit(part)).toBe(true);
    expect(handNote(part)).toBe('Part of this is for you to do in Confluence: Redraw loop.png.');
  });
});
