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

// A space the size of the one the app is built for, about 3,200 pages, is indexed completely in a few
// hundred requests and can be asked about (ADR-054, design doc 0008). How long the server takes to
// answer meanwhile is timed by the scale check, `pnpm run test:scale`, outside CI (ADR-057).

import { describe, expect, it } from 'vitest';
import { PAGES, startLargeSpace, walk } from './support/largeSpace.js';

describe('a 3,200-page space', () => {
  it('is indexed in at most one request per five pages, and a question about it is answered', async () => {
    const space = await startLargeSpace();
    try {
      const { status, missing, answered } = await walk(space);
      expect(status).toBe('completed');
      expect(missing).toBe(0);
      // Pages are packed several to a request, so 3,200 pages take a few hundred, not thousands.
      expect(space.indexRequests()).toBeLessThanOrEqual(PAGES / 5);
      expect(answered.turns.at(-1)?.corpus).toEqual({ pages: PAGES, mode: 'retrieved' });
    } finally {
      await space.close();
    }
  }, 120_000);
});
