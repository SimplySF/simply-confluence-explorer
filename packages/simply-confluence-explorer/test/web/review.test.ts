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

// The browser and the server sort a chat's review into the same four steps (design doc 0015).

import { describe, expect, it } from 'vitest';
import type { BranchItem, BranchRun, ChatQueue, SuggestionView } from '../../src/api/types.js';
import { reviewCounts as serverCounts } from '../../src/ai/chatQueue.js';
import { countsLine, reviewCounts, stepOf } from '../../web/src/support/review.js';

const item = (status: BranchItem['status'], staged = false): BranchItem =>
  ({ pageId: status + String(staged), title: status, status, staged }) as BranchItem;
const STATUSES: Array<BranchItem['status']> = [
  'pending',
  'checking',
  'working',
  'proposed',
  'accepted',
  'rejected',
  'skipped',
  'failed',
  'checked',
  'check-failed',
  'push-failed',
  'pushed',
];
const queue: ChatQueue = {
  suggestions: [{ state: 'open' }, { state: 'open' }, { state: 'staged' }] as SuggestionView[],
  runs: [{ items: [...STATUSES.map((s) => item(s)), ...STATUSES.map((s) => item(s, true))] } as BranchRun],
};

describe("a chat's review in steps", () => {
  it('counts every kind of edit the same way in the browser as on the server', () => {
    expect(reviewCounts(queue)).toEqual(serverCounts(queue));
    expect(reviewCounts(queue)).toEqual({ review: 2, edit: 7, stage: 1, push: 11 });
  });

  it('puts a staged page at Push until it is pushed, and a decided one at Stage', () => {
    expect(stepOf(item('accepted'))).toBe('stage');
    expect(stepOf(item('accepted', true))).toBe('push');
    expect(stepOf(item('pushed', true))).toBeUndefined();
    expect(stepOf(item('rejected'))).toBeUndefined();
  });

  it('says what waits in a line, leaving out the steps with nothing', () => {
    expect(countsLine({ review: 4, edit: 1, stage: 0, push: 1 })).toBe('4 suggestions · 1 edit to decide · 1 staged');
    expect(countsLine({ review: 0, edit: 0, stage: 0, push: 0 })).toBe('');
  });
});
