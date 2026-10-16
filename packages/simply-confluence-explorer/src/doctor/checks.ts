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

import type { DoctorLevel, DoctorReport, DoctorResult } from '../api/types.js';

// The doctor says what is wrong with this setup and what to type to fix it (ADR-016). Each check is
// a plain function over the values in `DoctorDeps`, so the checks are tested without a Confluence,
// a network or a particular machine. A setup failure that gets fixed ships with the check that
// detects it.

export const CHECK_IDS = ['node-version', 'confluence-config', 'server-type', 'tls-verification', 'data-dir'] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** The oldest Node major version the package supports, matching `engines` in package.json. */
export const MIN_NODE_MAJOR = 22;

/** Everything the checks read about the machine and the configuration. */
export type DoctorDeps = {
  nodeVersion: string;
  platform: NodeJS.Platform;
  connection: { baseUrl: string; token: string };
  dataDir: { path: string; writable: boolean };
  /** The value of NODE_EXTRA_CA_CERTS, which is how an internal certificate authority is trusted. */
  extraCaCerts?: string;
};

type Result = DoctorResult & { id: CheckId };

const result = (id: CheckId, level: DoctorLevel, summary: string, fix?: string): Result =>
  fix ? { id, level, summary, fix } : { id, level, summary };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Not a URL; the configuration check reports that.
    return '';
  }
}

const isLocalHost = (host: string): boolean => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

function nodeVersion(d: DoctorDeps): Result {
  const major = Number(d.nodeVersion.replace(/^v/, '').split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? result('node-version', 'ok', `Node ${d.nodeVersion}`)
    : result(
        'node-version',
        'fail',
        `Node ${d.nodeVersion} is older than ${MIN_NODE_MAJOR}`,
        `install Node ${MIN_NODE_MAJOR} or newer`,
      );
}

function confluenceConfig(d: DoctorDeps): Result {
  const { baseUrl, token } = d.connection;
  if (!baseUrl) {
    return result(
      'confluence-config',
      'warn',
      'no Confluence is configured yet',
      'connect in Settings, or set CONFLUENCE_URL and CONFLUENCE_PERSONAL_TOKEN',
    );
  }
  if (!hostOf(baseUrl)) {
    return result(
      'confluence-config',
      'fail',
      `the Confluence URL is not a URL: ${baseUrl}`,
      'use the address you open Confluence at, such as https://confluence.example.com',
    );
  }
  if (!token) {
    return result(
      'confluence-config',
      'fail',
      `there is no personal access token for ${baseUrl}`,
      'create one in Confluence under Profile > Personal Access Tokens, and save it in Settings',
    );
  }
  return result('confluence-config', 'ok', `Confluence at ${baseUrl}`);
}

// Only Confluence Server and Data Center are supported (ADR-002).
function serverType(d: DoctorDeps): Result {
  const host = hostOf(d.connection.baseUrl);
  if (!host) return result('server-type', 'skip', 'no Confluence is configured');
  if (host.endsWith('.atlassian.net')) {
    return result(
      'server-type',
      'fail',
      `${d.connection.baseUrl} is Atlassian Cloud, which this app does not support`,
      'connect to a Confluence Server or Data Center instance instead',
    );
  }
  return result('server-type', 'ok', 'Confluence Server or Data Center');
}

// Certificates are always verified. A Confluence whose certificate comes from an internal
// certificate authority is reached by trusting that authority, never by turning checks off.
function tlsVerification(d: DoctorDeps): Result {
  const { baseUrl } = d.connection;
  const host = hostOf(baseUrl);
  if (!host) return result('tls-verification', 'skip', 'no Confluence is configured');
  if (baseUrl.startsWith('http://') && !isLocalHost(host)) {
    return result(
      'tls-verification',
      'warn',
      `${host} uses plain HTTP, so the token and every page cross the network unencrypted`,
      'use the https:// address of your Confluence',
    );
  }
  if (d.extraCaCerts) {
    return result('tls-verification', 'ok', `certificates are verified, also against ${d.extraCaCerts}`);
  }
  return result(
    'tls-verification',
    'ok',
    baseUrl.startsWith('https://') ? 'certificates are verified' : 'local plain-HTTP connection',
  );
}

function dataDir(d: DoctorDeps): Result {
  if (!d.dataDir.writable) {
    return result(
      'data-dir',
      'fail',
      `cannot write to the data directory ${d.dataDir.path}`,
      'make it writable by the user running the app, or choose another with --data-dir',
    );
  }
  // Windows ignores the 0600 mode the token is written with (design doc 0003).
  const protection =
    d.platform === 'win32'
      ? "; the token file is protected only by your Windows profile's permissions"
      : '; the token file is readable only by you';
  return result('data-dir', 'ok', `data is kept in ${d.dataDir.path}${protection}`);
}

/**
 * Runs every check.
 */
export function runDoctor(d: DoctorDeps): DoctorReport {
  const results = [nodeVersion(d), confluenceConfig(d), serverType(d), tlsVerification(d), dataDir(d)];
  return { results, ok: !results.some((r) => r.level === 'fail') };
}

const MARK: Record<DoctorLevel, string> = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

/**
 * Formats a report for a terminal.
 */
export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    lines.push(`${MARK[r.level]} ${r.id.padEnd(18)} ${r.summary}`);
    if (r.fix) lines.push(`    fix: ${r.fix}`);
  }
  const count = (level: DoctorLevel): number => report.results.filter((r) => r.level === level).length;
  lines.push(
    '',
    `${count('ok')} passed, ${count('warn')} warning(s), ${count('fail')} failure(s), ${count('skip')} not applicable`,
  );
  return lines.join('\n');
}
