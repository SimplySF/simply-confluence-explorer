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
import { ago, syncLine } from '../../web/src/support/spaceStatus.js';

const now = Date.parse('2026-10-23T12:00:00Z');

describe("the sidebar's line about a space", () => {
  it('says how long ago in the largest whole unit', () => {
    expect(ago('2026-10-23T11:59:40Z', now)).toBe('just now');
    expect(ago('2026-10-23T11:15:00Z', now)).toBe('45 min ago');
    expect(ago('2026-10-23T09:30:00Z', now)).toBe('2 h ago');
    expect(ago('2026-10-20T12:00:00Z', now)).toBe('3 d ago');
  });

  it('counts the synced pages and says when, or that the space is not synced', () => {
    expect(syncLine({ pageCount: 3200, lastSynced: '2026-10-23T10:00:00Z' }, now)).toBe('3,200 synced · 2 h ago');
    expect(syncLine(undefined, now)).toBe('Not synced');
  });
});
