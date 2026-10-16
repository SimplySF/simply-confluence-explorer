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

import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionStore } from '../confluence/connection.js';
import type { DoctorDeps } from './checks.js';

// A directory that does not exist yet is fine, as long as it can be created.
function writable(dir: string): boolean {
  let target = dir;
  while (!fs.existsSync(target)) {
    const parent = path.dirname(target);
    if (parent === target) return false;
    target = parent;
  }
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    // Not writable: the data-dir check reports it with the fix.
    return false;
  }
}

/**
 * Reads what the doctor's checks need from this machine.
 */
export function systemDeps(dataDir: string, connection: ConnectionStore, env: NodeJS.ProcessEnv): DoctorDeps {
  const { baseUrl, token } = connection.resolve();
  return {
    nodeVersion: process.version,
    platform: process.platform,
    connection: { baseUrl, token },
    dataDir: { path: dataDir, writable: writable(dataDir) },
    extraCaCerts: env.NODE_EXTRA_CA_CERTS,
  };
}
