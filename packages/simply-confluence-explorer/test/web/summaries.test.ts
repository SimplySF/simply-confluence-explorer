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
import { summaryAction } from '../../web/src/support/summaries.js';

describe('the Space menu, for AI summaries', () => {
  it('does not offer to regenerate when every page has a summary, because the run would do nothing', () => {
    const action = summaryAction({ pageCount: 12, metadataCount: 12 });
    expect(action.done).toBe(true);
    expect(action.label).not.toMatch(/regenerate/i);
  });

  it('offers to update when some pages have no up-to-date summary', () => {
    expect(summaryAction({ pageCount: 12, metadataCount: 5 })).toMatchObject({
      label: 'Update the AI index (5/12)',
      done: false,
    });
  });

  it('offers to generate for a space with no summaries, or no synced copy', () => {
    expect(summaryAction({ pageCount: 12, metadataCount: 0 }).label).toBe('Build the AI index');
    expect(summaryAction(undefined).done).toBe(false);
  });

  it('says what a run would cost before it starts', () => {
    expect(summaryAction({ pageCount: 3200, metadataCount: 0 }, { missing: 3200, requests: 450 }).hint).toMatch(
      /^3,200 pages in about 450 requests\. /,
    );
  });
});
