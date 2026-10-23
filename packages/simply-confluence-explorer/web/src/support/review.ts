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

// A chat's review in four steps (design doc 0015): its suggestions to review, the edits made from
// them to decide, the decided pages to stage, and the staged pages to push. The server counts a queue
// into the same steps for the Review page; a test checks that the two agree.

import type { BranchItem, BranchItemStatus, ChatQueue, ReviewCounts } from '../../../src/api/types.js';

export type Step = 'review' | 'edit' | 'stage' | 'push';

export const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'review', label: 'Review' },
  { id: 'edit', label: 'Edit' },
  { id: 'stage', label: 'Stage' },
  { id: 'push', label: 'Push' },
];

const TO_DECIDE = new Set<BranchItemStatus>([
  'pending',
  'checking',
  'working',
  'proposed',
  'failed',
  'check-failed',
  'push-failed',
]);

/** The step an edited page waits at, or none once it is pushed, rejected or not edited. */
export function stepOf(item: Pick<BranchItem, 'status' | 'staged'>): Step | undefined {
  if (item.staged) return item.status === 'pushed' ? undefined : 'push';
  if (TO_DECIDE.has(item.status)) return 'edit';
  return item.status === 'accepted' ? 'stage' : undefined;
}

/** How much waits at each step. */
export function reviewCounts(queue: ChatQueue | null): ReviewCounts {
  const items = queue?.runs.flatMap((r) => r.items) ?? [];
  const at = (step: Step): number => items.filter((i) => stepOf(i) === step).length;
  return {
    review: queue?.suggestions.filter((s) => s.state === 'open').length ?? 0,
    edit: at('edit'),
    stage: at('stage'),
    push: at('push'),
  };
}

/** "4 suggestions · 1 edit to decide · 1 staged", leaving out the steps with nothing waiting. */
export function countsLine(counts: ReviewCounts): string {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  return [
    counts.review ? plural(counts.review, 'suggestion', 'suggestions') : '',
    counts.edit ? plural(counts.edit, 'edit to decide', 'edits to decide') : '',
    counts.stage ? plural(counts.stage, 'page to stage', 'pages to stage') : '',
    counts.push ? `${counts.push} staged` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
