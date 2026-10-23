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
import { headerCount } from '../../web/src/support/problems.js';

describe("the header's count of problems", () => {
  it('counts what failed since the person looked, and never a freeze', () => {
    const seen = '2026-10-23T10:00:00Z';
    expect(
      headerCount(
        [
          { at: '2026-10-23T09:00:00Z', problem: 'ai-failures' },
          { at: '2026-10-23T11:00:00Z', problem: 'ai-failures' },
          { at: '2026-10-23T11:05:00Z', problem: 'frozen' },
        ],
        seen,
      ),
    ).toBe(1);
  });
});
