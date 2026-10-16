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

// What the end-to-end suite needs from the Confluence test environment: its address and token, the
// data directory the seed wrote the exclusion rules into, and the seed manifest that maps each page
// title to the id Confluence gave it.

import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpaceExpectations } from '../../../../test-env/fixtures/dataset.mjs';
import { createServer } from '../../src/server.js';

export type SeedSpace = {
  name: string;
  homeId: string;
  homeTitle: string;
  pages: Record<string, { id: string; parent: string | null; depth: number }>;
  expectations: SpaceExpectations;
};

export type TestEnv = {
  baseUrl: string;
  token: string;
  dataDir: string;
  spaces: Record<string, SeedSpace>;
};

const stateDir = fileURLToPath(new URL('../../../../test-env/.state/', import.meta.url));

function readState<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8')) as T;
  } catch {
    // Not started yet: the suite skips, and SKIP_REASON says how to start it.
    return undefined;
  }
}

/** The running test environment, or `undefined` when it has not been started. */
export function loadTestEnv(): TestEnv | undefined {
  const manifest = readState<{ spaces: Record<string, SeedSpace> }>('seed-manifest.json');
  const creds = readState<{ baseUrl: string; token: string }>('credentials.json');
  const baseUrl = process.env.CONFLUENCE_URL ?? creds?.baseUrl;
  const token = process.env.CONFLUENCE_PERSONAL_TOKEN ?? creds?.token;
  if (!manifest || !baseUrl || !token) return undefined;
  return { baseUrl, token, dataDir: path.join(stateDir, 'data'), spaces: manifest.spaces };
}

export const SKIP_REASON = 'the Confluence test environment is not running: start it with pnpm run testenv:start';

/** Starts the app against the test environment, as `confluence-explorer` would run it. */
export async function startApp(env: TestEnv): Promise<{ server: http.Server; api: string }> {
  const server = createServer({
    webRoot: env.dataDir,
    dataDir: env.dataDir,
    env: { CONFLUENCE_URL: env.baseUrl, CONFLUENCE_PERSONAL_TOKEN: env.token, CONFLUENCE_EXPLORER_PROFILE: 'dev' },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
}

/** Every page title in a space that is excluded, or sits below an excluded page. */
export function hiddenTitles(space: SeedSpace): Set<string> {
  const excluded = new Set(space.expectations.excluded);
  const hidden = new Set<string>();
  for (const title of Object.keys(space.pages)) {
    for (let t: string | null = title; t; t = space.pages[t]?.parent ?? null) {
      if (excluded.has(t)) {
        hidden.add(title);
        break;
      }
    }
  }
  return hidden;
}
