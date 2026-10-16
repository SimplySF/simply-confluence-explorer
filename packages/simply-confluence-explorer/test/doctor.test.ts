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

// The doctor reports what is wrong with a setup, and every finding says what to do about it. A
// finding that a person cannot act on teaches them to ignore the rest.

import { describe, expect, it } from 'vitest';
import { CHECK_IDS, renderDoctor, runDoctor, type DoctorDeps } from '../src/doctor/checks.js';

const HOUR = 3_600_000;

const healthy = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  nodeVersion: 'v22.13.0',
  platform: 'linux',
  connection: { baseUrl: 'https://confluence.example.com', token: 'pat' },
  dataDir: { path: '/data', writable: true },
  profile: '',
  verify: () => Promise.resolve({ success: true, displayName: 'Test Admin' }),
  ignoreFiles: [{ spaceKey: 'PLAT', readable: true, patterns: ['Restricted/', 'id:1001'] }],
  guardFiles: [{ spaceKey: 'PLAT', rules: 2 }],
  ai: { available: true, engine: 'Claude (claude-opus-5-5)' },
  license: () => Promise.resolve({ expired: false, expiryDate: 2 * HOUR }),
  now: 0,
  ...over,
});

const find = async (deps: DoctorDeps, id: string): Promise<{ level: string; summary: string; fix?: string }> =>
  (await runDoctor(deps)).results.find((r) => r.id === id)!;

describe('the doctor', () => {
  it('runs exactly the declared checks', async () => {
    expect((await runDoctor(healthy())).results.map((r) => r.id)).toEqual([...CHECK_IDS]);
  });

  it('passes a healthy setup', async () => {
    const report = await runDoctor(healthy());
    expect(report.ok).toBe(true);
    for (const r of report.results) expect(['ok', 'skip'], `${r.id}: ${r.summary}`).toContain(r.level);
  });

  it('gives a fix with every warning and failure', async () => {
    const report = await runDoctor(
      healthy({
        nodeVersion: 'v20.0.0',
        connection: { baseUrl: 'http://wiki.example.com', token: 'pat' },
        dataDir: { path: '/data', writable: false },
        verify: () => Promise.resolve({ success: false, error: '401' }),
        ignoreFiles: [
          { spaceKey: 'HR', readable: false, patterns: [] },
          { spaceKey: 'OPS', readable: true, patterns: ['1234'] },
        ],
      }),
    );
    const flagged = report.results.filter((r) => r.level === 'warn' || r.level === 'fail');
    expect(flagged.length).toBeGreaterThanOrEqual(6);
    for (const r of flagged) expect(r.fix?.length, `${r.id} has no fix`).toBeGreaterThan(5);
  });

  it('fails only on a failure, so warnings alone still let the app start', async () => {
    expect((await runDoctor(healthy({ connection: { baseUrl: '', token: '' } }))).ok).toBe(true);
    expect((await runDoctor(healthy({ dataDir: { path: '/data', writable: false } }))).ok).toBe(false);
  });

  it('treats an unconfigured app as a warning and asks nothing of a Confluence', async () => {
    let asked = false;
    const deps = healthy({
      connection: { baseUrl: '', token: '' },
      verify: () => ((asked = true), Promise.resolve({ success: true })),
    });
    expect((await find(deps, 'confluence-config')).level).toBe('warn');
    expect((await find(deps, 'server-type')).level).toBe('skip');
    expect((await find(deps, 'confluence-auth')).level).toBe('skip');
    expect((await find(deps, 'tls-verification')).level).toBe('skip');
    expect(asked).toBe(false);
  });

  it('refuses Atlassian Cloud before any request is made, because the app does not support it (ADR-002)', async () => {
    const deps = healthy({ connection: { baseUrl: 'https://acme.atlassian.net', token: 't' } });
    expect((await find(deps, 'server-type')).level).toBe('fail');
    expect((await find(deps, 'confluence-auth')).level).toBe('skip');
  });

  it('fails a token Confluence rejects, and points at the certificate fix for a certificate error', async () => {
    const result = await find(
      healthy({ verify: () => Promise.resolve({ success: false, error: 'certificate' }) }),
      'confluence-auth',
    );
    expect(result.level).toBe('fail');
    expect(result.fix).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('fails a .confluenceignore it cannot read, because every page in that space is then excluded', async () => {
    const result = await find(
      healthy({ ignoreFiles: [{ spaceKey: 'HR', readable: false, patterns: [] }] }),
      'ignore-files',
    );
    expect(result.level).toBe('fail');
    expect(result.summary).toContain('every page there is excluded');
  });

  it('warns about a bare page id rule, which also matches titles containing it (ADR-013)', async () => {
    const deps = healthy({ ignoreFiles: [{ spaceKey: 'OPS', readable: true, patterns: ['1234'] }] });
    expect((await find(deps, 'ignore-rules')).level).toBe('warn');
  });

  it('fails a .confluenceguard that does not parse, because its protection would be missing (ADR-022)', async () => {
    const result = await find(
      healthy({ guardFiles: [{ spaceKey: 'OPS', error: 'line 2: expected "allow:"' }] }),
      'guard-rules',
    );
    expect(result.level).toBe('fail');
    expect(result.summary).toContain('OPS: line 2');
  });

  it('warns when no AI engine is set up, and says what is unavailable without one', async () => {
    const result = await find(healthy({ ai: { available: false, engine: 'none' } }), 'ai-engine');
    expect(result.level).toBe('warn');
    expect(result.summary).toMatch(/questions, summaries/);
  });

  it('checks the test license only against the test environment, and warns before it runs out (ADR-004)', async () => {
    expect((await find(healthy(), 'test-license')).level).toBe('skip');
    expect((await find(healthy({ profile: 'dev' }), 'test-license')).level).toBe('ok');
    const soon = healthy({
      profile: 'dev',
      license: () => Promise.resolve({ expired: false, expiryDate: 10 * 60_000 }),
    });
    expect((await find(soon, 'test-license')).level).toBe('warn');
    const gone = healthy({ profile: 'dev', license: () => Promise.resolve({ expired: true, expiryDate: 0 }) });
    expect((await find(gone, 'test-license')).level).toBe('fail');
  });

  it('warns about plain HTTP to another machine, but not to this one', async () => {
    const remote = healthy({ connection: { baseUrl: 'http://wiki.example.com', token: 't' } });
    const local = healthy({ connection: { baseUrl: 'http://localhost:8090', token: 't' } });
    expect((await find(remote, 'tls-verification')).level).toBe('warn');
    expect((await find(local, 'tls-verification')).level).toBe('ok');
  });

  it('names the extra certificate authority it trusts, so an internal CA is visible in the report', async () => {
    expect((await find(healthy({ extraCaCerts: '/etc/ssl/corp-ca.pem' }), 'tls-verification')).summary).toContain(
      '/etc/ssl/corp-ca.pem',
    );
  });

  it("says on Windows that the token file is protected only by the profile's permissions", async () => {
    expect((await find(healthy({ platform: 'win32' }), 'data-dir')).summary).toMatch(/Windows profile/);
    expect((await find(healthy(), 'data-dir')).summary).toMatch(/readable only by you/);
  });

  it('renders one line per check and a count of each outcome', async () => {
    const text = renderDoctor(await runDoctor(healthy({ connection: { baseUrl: '', token: '' } })));
    expect(text).toContain('confluence-config');
    expect(text).toMatch(/\d+ passed, 1 warning\(s\), 0 failure\(s\), 4 not applicable/);
  });
});
