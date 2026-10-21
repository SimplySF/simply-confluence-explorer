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
// the sections it retrieved from many, perhaps over several requests, or all of many over several
// requests (ADR-051).

import type { ManifestSummary } from '../../../src/ai/manifest.js';
import type { SessionTurn } from '../../../src/api/types.js';

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

export function readLabel(turn: Pick<SessionTurn, 'matchedPages' | 'considered' | 'corpus'>): string {
  const pages = turn.matchedPages ?? [];
  const sections = pages.reduce((n, p) => n + (p.sections?.length ?? 0), 0);
  if (turn.corpus?.mode === 'batched')
    return `Read all ${plural(turn.corpus.pages, 'page')} in ${plural(turn.corpus.batches ?? 1, 'batch', 'batches')}`;
  if (turn.corpus?.mode === 'retrieved')
    return `Read ${plural(sections, 'section')} from ${plural(pages.length, 'page')}${
      turn.corpus.batches ? ` in ${plural(turn.corpus.batches, 'batch', 'batches')}` : ''
    } · searched ${plural(turn.corpus.pages, 'page')}`;
  if (turn.corpus && turn.corpus.pages === pages.length && pages.length > 1) return `Read all ${pages.length} pages`;
  return `Read ${plural(pages.length, 'page')}`;
}

const REASON: Record<ManifestSummary['leftOut'][number]['reason'], string> = {
  excluded: "excluded by the space's rules",
  secret: 'holds a secret',
  'over-limit': 'over the size limit',
  'history-limit': 'the conversation was longer than a request carries',
  cut: 'sent in part, cut to the size a file may have',
};

/**
 * What an answer's request carried to the model, as the line under What was sent, and each thing left
 * out with why. An excluded page is counted, never named (ADR-054).
 */
export function sentLines(sent: ManifestSummary): { summary: string; leftOut: string[] } {
  const parts = [
    sent.pages && plural(sent.pages, 'page'),
    sent.sections && plural(sent.sections, 'section'),
    sent.files && plural(sent.files, 'file'),
    sent.images && plural(sent.images, 'image'),
    sent.turns && plural(sent.turns, 'earlier message'),
  ].filter(Boolean);
  const excluded = sent.leftOut.filter((l) => l.reason === 'excluded').length;
  const leftOut = [
    ...sent.leftOut.filter((l) => l.reason !== 'excluded').map((l) => `${l.label}: ${REASON[l.reason]}`),
    ...(excluded ? [`${plural(excluded, 'page')}: ${REASON.excluded}`] : []),
  ];
  return {
    summary: `Sent ${parts.length ? parts.join(', ') : 'no pages'} · ${sent.chars.toLocaleString('en-US')} characters`,
    leftOut,
  };
}
