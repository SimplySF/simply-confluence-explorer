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

// What the Space menu offers for a space's AI summaries. A run only summarises pages that have no
// summary yet, so once every page has one there is nothing for it to do, and the menu says so.

import type { SyncedSpace } from '../../../src/api/types.js';

export type SummaryAction = { label: string; hint: string; done: boolean };

export function summaryAction(manifest?: Pick<SyncedSpace, 'pageCount' | 'metadataCount'>): SummaryAction {
  const offer = { hint: 'Summaries and tags for every page, and the table of contents', done: false };
  if (!manifest) return { ...offer, label: 'Generate AI summaries' };
  const { pageCount, metadataCount } = manifest;
  if (pageCount > 0 && metadataCount >= pageCount)
    return { label: 'Every page has an AI summary', hint: "Redo one page's summary from its Details tab", done: true };
  if (metadataCount > 0) return { ...offer, label: `Resume AI summaries (${metadataCount}/${pageCount})` };
  return { ...offer, label: 'Generate AI summaries' };
}
