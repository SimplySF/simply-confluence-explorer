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
import { guardRulesPath, parseGuardRules } from '../ai/guard.js';
import { ConfluenceClient } from '../confluence/client.js';
import type { ConnectionStore } from '../confluence/connection.js';
import type { ExclusionManager } from '../spaces/exclusionManager.js';
import { Telemetry } from '../telemetry/telemetry.js';
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

function ignoreFiles(dataDir: string, exclusions: ExclusionManager): DoctorDeps['ignoreFiles'] {
  const spacesDir = path.join(dataDir, 'spaces');
  if (!fs.existsSync(spacesDir)) return [];
  return fs
    .readdirSync(spacesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(exclusions.ignoreFilePath(entry.name)))
    .map((entry) => {
      try {
        fs.accessSync(exclusions.ignoreFilePath(entry.name), fs.constants.R_OK);
        return { spaceKey: entry.name, readable: true, patterns: exclusions.patterns(entry.name) };
      } catch {
        // Unreadable: the ignore-files check reports it, with the fix.
        return { spaceKey: entry.name, readable: false, patterns: [] };
      }
    });
}

function guardFiles(dataDir: string): DoctorDeps['guardFiles'] {
  const spacesDir = path.join(dataDir, 'spaces');
  if (!fs.existsSync(spacesDir)) return [];
  return fs
    .readdirSync(spacesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(guardRulesPath(dataDir, entry.name)))
    .map((entry) => {
      try {
        const rules = parseGuardRules(fs.readFileSync(guardRulesPath(dataDir, entry.name), 'utf8'));
        return { spaceKey: entry.name, rules: rules.allow.length + rules.block.length + rules.redact.length };
      } catch (error) {
        return { spaceKey: entry.name, error: (error as Error).message };
      }
    });
}

/**
 * Reads what the doctor's checks need from this machine and from Confluence.
 */
/** The problems telemetry raised in the last day, read without starting anything. */
function recentProblems(dataDir: string): DoctorDeps['telemetry'] {
  const telemetry = new Telemetry({ dataDir, timers: false });
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const problems: DoctorDeps['telemetry']['problems'] = [];
  for (const record of telemetry.records(since)) {
    if (record.at < since) break;
    if (record.type === 'problem') problems.push({ at: record.at, message: record.message, traceId: record.traceId });
  }
  return { path: telemetry.dir, problems };
}

export function systemDeps(
  dataDir: string,
  connection: ConnectionStore,
  exclusions: ExclusionManager,
  ai: { isAvailable: () => boolean; getEngine: () => string },
  env: NodeJS.ProcessEnv,
): DoctorDeps {
  const { baseUrl, token } = connection.resolve();
  const client = new ConfluenceClient({ baseUrl, token });
  return {
    nodeVersion: process.version,
    platform: process.platform,
    connection: { baseUrl, token },
    dataDir: { path: dataDir, writable: writable(dataDir) },
    extraCaCerts: env.NODE_EXTRA_CA_CERTS,
    profile: env.CONFLUENCE_EXPLORER_PROFILE ?? '',
    verify: async (): Promise<{ success: boolean; displayName?: string; error?: string }> => {
      const answer = await client.verify();
      return { success: answer.success, displayName: answer.user?.displayName, error: answer.error };
    },
    ignoreFiles: ignoreFiles(dataDir, exclusions),
    guardFiles: guardFiles(dataDir),
    ai: { available: ai.isAvailable(), engine: ai.getEngine() },
    license: () => client.getLicenseDetails(),
    telemetry: recentProblems(dataDir),
    now: Date.now(),
  };
}
