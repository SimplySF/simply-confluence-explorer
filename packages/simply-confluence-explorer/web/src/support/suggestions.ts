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

// Whether a suggestion in a chat's review queue can become an edit, and when it cannot, or can only
// in part, the reason the review queue shows beside it, so no row is left without a checkbox unexplained.

import type { SuggestionView } from '../../../src/api/types.js';

type Suggestion = Pick<SuggestionView, 'kind' | 'pages' | 'pageIds' | 'byHand' | 'byHandOnly'>;

const quoted = (titles: string[]): string => titles.map((t) => `“${t}”`).join(', ');

/** Whether a suggestion can be ticked: an edit of a page the chat read can carry it out. */
export const canEdit = (s: Suggestion): boolean =>
  s.kind !== 'placement' && s.kind !== 'gap' && !s.byHandOnly && Object.keys(s.pageIds).length > 0;

/** The part of a suggestion an edit leaves for a person to do in Confluence (ADR-068). */
export const handNote = (s: Pick<SuggestionView, 'byHand' | 'byHandOnly'>): string | undefined =>
  s.byHand && !s.byHandOnly ? `Part of this is for you to do in Confluence: ${s.byHand}` : undefined;

/** Why a suggestion cannot be edited, or which of its pages will not be, or nothing. */
export function editNote(s: Suggestion): string | undefined {
  if (s.kind === 'gap') return 'This needs a new page, so it cannot be applied as an edit.';
  if (s.kind === 'placement') return 'This needs a page moved, split or merged: do it in Confluence.';
  if (s.byHandOnly) return `The AI cannot make this change: ${s.byHand ?? ''} Change it in Confluence.`;
  const unread = s.pages.filter((p) => !s.pageIds[p]);
  if (s.pages.length === 0) return 'This names no page, so it cannot be applied as an edit.';
  if (unread.length === s.pages.length)
    return `This names a page this chat did not read, ${quoted(unread)}, so it cannot be edited here. Ask about that page to edit it.`;
  if (unread.length) return `${quoted(unread)} was not read by this chat, so only the other pages are edited.`;
  return undefined;
}
