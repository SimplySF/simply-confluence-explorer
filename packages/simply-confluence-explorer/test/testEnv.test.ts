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

// The test environment's own commands, where they are plain functions that need no containers.

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envLines } from '../../../test-env/testenv.mjs';

describe('node test-env/testenv.mjs env', () => {
  it('prints the connection and the data directory the seed wrote the exclusion rules into', () => {
    const lines = envLines({ baseUrl: 'http://localhost:8090', token: 'pat' });
    expect(lines).toContain('CONFLUENCE_URL=http://localhost:8090');
    expect(lines).toContain('CONFLUENCE_PERSONAL_TOKEN=pat');
    const data = lines.find((l) => l.startsWith('CONFLUENCE_EXPLORER_DATA='));
    expect(data?.split('=')[1]).toMatch(new RegExp(`test-env\\${path.sep}\\.state\\${path.sep}data$`));
  });
});
