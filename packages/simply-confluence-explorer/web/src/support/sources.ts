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

// The line above an answer's sources, which says how much of the chat's pages it read: all of them,
// or the sections it retrieved from many (ADR-051).

import type { SessionTurn } from '../../../src/api/types.js';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function readLabel(turn: Pick<SessionTurn, 'matchedPages' | 'considered' | 'corpus'>): string {
  const pages = turn.matchedPages ?? [];
  const sections = pages.reduce((n, p) => n + (p.sections?.length ?? 0), 0);
  if (turn.corpus?.mode === 'retrieved')
    return `Read ${plural(sections, 'section')} from ${plural(pages.length, 'page')} · searched ${plural(turn.corpus.pages, 'page')}`;
  if (turn.corpus && turn.corpus.pages === pages.length && pages.length > 1) return `Read all ${pages.length} pages`;
  return `Read ${plural(pages.length, 'page')}`;
}
