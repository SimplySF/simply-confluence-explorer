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

// What the Space menu offers for a space's AI index: each page's summary, topics, section notes and
// the questions it answers, and its embeddings when the provider makes them (ADR-051). A run only
// indexes pages that are not indexed yet, so once every page is there is nothing for it to do, and
// the menu says so. A page indexed by an older kind of run, or at an older version, does not count.

import type { SyncedSpace } from '../../../src/api/types.js';

export type SummaryAction = { label: string; hint: string; done: boolean };

/**
 * @param manifest The synced space's counts.
 * @param estimate How many pages a run would index and about how many requests that takes, so a large
 *   space says what it is about to cost before it starts.
 */
export function summaryAction(
  manifest?: Pick<SyncedSpace, 'pageCount' | 'metadataCount'>,
  estimate?: { missing: number; requests?: number },
): SummaryAction {
  const what = 'Summaries, topics, section notes and the questions each page answers, which chats search';
  const offer = {
    hint: estimate?.requests
      ? `${estimate.missing.toLocaleString('en-US')} pages in about ${estimate.requests.toLocaleString('en-US')} requests. ${what}`
      : what,
    done: false,
  };
  if (!manifest) return { ...offer, label: 'Build the AI index' };
  const { pageCount, metadataCount } = manifest;
  if (pageCount > 0 && metadataCount >= pageCount)
    return { label: 'The AI index is up to date', hint: 'Re-index one page from its Details tab', done: true };
  if (metadataCount > 0) return { ...offer, label: `Update the AI index (${metadataCount}/${pageCount})` };
  return { ...offer, label: 'Build the AI index' };
}
