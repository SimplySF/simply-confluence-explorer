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

export const CHECK_IDS = [
  'node-version',
  'confluence-config',
  'server-type',
  'confluence-auth',
  'tls-verification',
  'data-dir',
  'ignore-files',
  'ignore-rules',
  'guard-rules',
  'ai-engine',
  'test-license',
  'telemetry',
] as const;
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
  /** `dev` when the app runs against the test environment, whose license expires. */
  profile: string;
  /** Asks Confluence who the token belongs to. */
  verify: () => Promise<{ success: boolean; displayName?: string; error?: string }>;
  /** Each space's `.confluenceignore`: whether it can be read, and its rules. */
  ignoreFiles: Array<{ spaceKey: string; readable: boolean; patterns: string[] }>;
  /** Each space's `.confluenceguard`: how many rules it has, or why it does not parse. */
  guardFiles: Array<{ spaceKey: string; rules?: number; error?: string }>;
  ai: { available: boolean; engine: string };
  /** The Data Center license, or `null` when it cannot be read. */
  license: () => Promise<{ expired: boolean; expiryDate: number } | null>;
  /** Where telemetry is kept, and the problems it raised in the last day, newest first (ADR-054). */
  telemetry: { path: string; problems: Array<{ at: string; message: string; traceId?: string }> };
  now: number;
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

async function confluenceAuth(d: DoctorDeps, config: Result, type: Result): Promise<Result> {
  if (config.level !== 'ok' || type.level !== 'ok')
    return result('confluence-auth', 'skip', 'no usable Confluence connection');
  const answer = await d.verify();
  if (answer.success) return result('confluence-auth', 'ok', `signed in as ${answer.displayName ?? 'an unnamed user'}`);
  return result(
    'confluence-auth',
    'fail',
    `Confluence did not accept the connection: ${answer.error ?? 'no reason was given'}`,
    'check that the URL opens from this machine and that the token has not expired; for a certificate error, see NODE_EXTRA_CA_CERTS in the README',
  );
}

// A file that cannot be read excludes its whole space (the rules fail closed), so the space is
// unusable rather than unsafe. That is the one way this check fails.
function ignoreFiles(d: DoctorDeps): Result {
  const unreadable = d.ignoreFiles.filter((f) => !f.readable).map((f) => f.spaceKey);
  if (unreadable.length > 0) {
    return result(
      'ignore-files',
      'fail',
      `.confluenceignore cannot be read for ${unreadable.join(', ')}, so every page there is excluded until it can`,
      `fix the file permissions on spaces/<KEY>/.confluenceignore in the data directory for ${unreadable.join(', ')}`,
    );
  }
  const withRules = d.ignoreFiles.filter((f) => f.patterns.length > 0);
  if (withRules.length === 0) return result('ignore-files', 'ok', 'no .confluenceignore rules, so nothing is excluded');
  const count = withRules.reduce((n, f) => n + f.patterns.length, 0);
  return result(
    'ignore-files',
    'ok',
    `${count} exclusion rule(s) across ${withRules.map((f) => f.spaceKey).join(', ')}`,
  );
}

// A bare number is read as a page id, and also as part of a title, so `1234` also hides any page
// whose title contains 1234 (ADR-013). Writing `id:1234` matches the id alone.
function ignoreRules(d: DoctorDeps): Result {
  const bare = d.ignoreFiles.flatMap((f) =>
    f.patterns.filter((p) => /^\d+$/.test(p)).map((p) => `${f.spaceKey}: ${p}`),
  );
  return bare.length > 0
    ? result(
        'ignore-rules',
        'warn',
        `bare page ids also match titles that contain them: ${bare.join(', ')}`,
        'write page ids as id:<number>',
      )
    : result('ignore-rules', 'ok', 'every page-id rule uses the id: form');
}

// A guard rule that does not parse would be a protection silently missing, so AI requests for that
// space are refused until it parses (ADR-022).
function guardRules(d: DoctorDeps): Result {
  const broken = d.guardFiles.filter((g) => g.error);
  if (broken.length > 0) {
    return result(
      'guard-rules',
      'fail',
      `.confluenceguard does not parse: ${broken.map((g) => `${g.spaceKey}: ${g.error ?? 'unknown error'}`).join('; ')}`,
      'fix the rule named above; AI requests for that space are refused until it parses',
    );
  }
  const rules = d.guardFiles.reduce((n, g) => n + (g.rules ?? 0), 0);
  return result(
    'guard-rules',
    'ok',
    rules > 0
      ? `outbound guard active, with ${rules} custom rule(s)`
      : 'outbound guard active, with its built-in rules',
  );
}

function aiEngine(d: DoctorDeps): Result {
  return d.ai.available
    ? result('ai-engine', 'ok', `AI engine: ${d.ai.engine}`)
    : result(
        'ai-engine',
        'warn',
        'no AI engine is set up, so questions, summaries and improvement proposals are unavailable',
        'choose a provider, model and key in Settings, or install the Gemini CLI',
      );
}

// The test environment's license lasts three hours from when Confluence starts (ADR-004).
async function testLicense(d: DoctorDeps, auth: Result): Promise<Result> {
  if (d.profile !== 'dev') return result('test-license', 'skip', 'not running against the test environment');
  if (auth.level !== 'ok') return result('test-license', 'skip', 'not connected');
  const license = await d.license();
  const restart = 'pnpm run testenv:down, then pnpm run testenv:start, which starts a fresh three hours';
  if (!license) return result('test-license', 'warn', 'the test license could not be read', 'pnpm run testenv:status');
  const minutes = Math.round((license.expiryDate - d.now) / 60_000);
  if (license.expired || minutes <= 0) return result('test-license', 'fail', 'the test license has expired', restart);
  if (minutes < 15) return result('test-license', 'warn', `the test license expires in ${minutes} minutes`, restart);
  return result('test-license', 'ok', `the test license is valid for ${minutes} more minutes`);
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

function telemetry(d: DoctorDeps): Result {
  const { path: where, problems } = d.telemetry;
  if (problems.length === 0)
    return result('telemetry', 'ok', `traces and logs are kept in ${where}; no problems in the last day`);
  const listed = problems
    .slice(0, 5)
    .map((p) => `\n    ${p.at.slice(0, 16).replace('T', ' ')} ${p.message}${p.traceId ? ` (trace ${p.traceId})` : ''}`)
    .join('');
  return result(
    'telemetry',
    'warn',
    `${problems.length} problem${problems.length === 1 ? '' : 's'} in the last day, kept in ${where}:${listed}`,
    'open the Observability page in the app to see each one with its trace',
  );
}

/**
 * Runs every check.
 */
export async function runDoctor(d: DoctorDeps): Promise<DoctorReport> {
  const config = confluenceConfig(d);
  const type = serverType(d);
  const auth = await confluenceAuth(d, config, type);
  const results = [
    nodeVersion(d),
    config,
    type,
    auth,
    tlsVerification(d),
    dataDir(d),
    ignoreFiles(d),
    ignoreRules(d),
    guardRules(d),
    aiEngine(d),
    await testLicense(d, auth),
    telemetry(d),
  ];
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
