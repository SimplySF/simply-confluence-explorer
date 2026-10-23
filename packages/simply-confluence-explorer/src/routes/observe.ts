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

import type { LogPage } from '../telemetry/query.js';
import type { Router } from '../http/router.js';
import type { Services } from './api.js';

// The Observability page's routes (design doc 0008). They only read what the app has recorded on
// this machine, and answer only this machine, like every route.

const RANGES: Record<string, number> = { '15m': 15, '1h': 60, '24h': 1440, '7d': 10_080, '14d': 20_160 };
const list = (value: string | null): string[] | undefined => value?.split(',').filter(Boolean);

export function addObserveRoutes(router: Router, services: Services): Router {
  const { telemetry, workers } = services;
  return router
    .add('GET', '/api/observe/now', () => telemetry.now())
    .add('GET', '/api/observe/logs', ({ query }) => {
      const minutes = RANGES[query.get('range') ?? '24h'] ?? RANGES['24h'];
      // Scanning a day of records takes a while, so it runs on a worker thread.
      return workers.run<LogPage>({
        kind: 'logs',
        dir: telemetry.recordsFolder(),
        query: {
          levels: list(query.get('level')),
          kinds: list(query.get('kind')),
          spaceKey: query.get('spaceKey')?.toUpperCase(),
          text: query.get('q') ?? undefined,
          since: new Date(Date.now() - minutes * 60_000).toISOString(),
          before: query.get('before') ?? undefined,
          limit: Number(query.get('limit')) || undefined,
        },
      });
    })
    .add('GET', '/api/observe/traces/:traceId', ({ params }) =>
      workers.run({ kind: 'trace', dir: telemetry.recordsFolder(), traceId: params.traceId }),
    );
}
