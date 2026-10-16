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

import type { ConnectionUpdate } from '../api/types.js';
import type { ConnectionStore } from '../confluence/connection.js';
import { runDoctor } from '../doctor/checks.js';
import { systemDeps } from '../doctor/system.js';
import { HttpError, Router } from '../http/router.js';
import type { ExclusionManager } from '../spaces/exclusionManager.js';
import { errorMessage } from '../util/errors.js';
import { addBrowseRoutes } from './browse.js';

/** The long-lived parts of the app that routes share. One of each exists per server. */
export type Services = {
  version: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  connection: ConnectionStore;
  exclusions: ExclusionManager;
  log: (message: string) => void;
};

/** The JSON body of `GET /api/health`. */
export type HealthResponse = {
  status: 'ok';
  version: string;
};

/**
 * Builds the `/api` routes.
 */
export function createApi(services: Services): Router {
  const { connection } = services;
  const router = new Router(services.log)
    .add('GET', '/api/health', (): HealthResponse => ({ status: 'ok', version: services.version }))
    .add('GET', '/api/connection', () => connection.publicView())
    .add('PUT', '/api/connection', ({ body }) => {
      try {
        connection.update(connectionUpdate(body));
      } catch (error) {
        throw new HttpError(400, errorMessage(error));
      }
      return connection.publicView();
    })
    .add('GET', '/api/doctor', () =>
      runDoctor(systemDeps(services.dataDir, connection, services.exclusions, services.env)),
    );
  return addBrowseRoutes(router, services);
}

function connectionUpdate(body: unknown): ConnectionUpdate {
  const fields = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const update: ConnectionUpdate = {};
  for (const key of ['baseUrl', 'token'] as const) {
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error(`${key} must be a string`);
    update[key] = value;
  }
  return update;
}
