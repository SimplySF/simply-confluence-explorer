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

const healthy = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  nodeVersion: 'v22.13.0',
  platform: 'linux',
  connection: { baseUrl: 'https://confluence.example.com', token: 'pat' },
  dataDir: { path: '/data', writable: true },
  ...over,
});

const find = (deps: DoctorDeps, id: string): { level: string; summary: string; fix?: string } =>
  runDoctor(deps).results.find((r) => r.id === id)!;

describe('the doctor', () => {
  it('runs exactly the declared checks', () => {
    expect(runDoctor(healthy()).results.map((r) => r.id)).toEqual([...CHECK_IDS]);
  });

  it('passes a healthy setup', () => {
    const report = runDoctor(healthy());
    expect(report.ok).toBe(true);
    for (const r of report.results) expect(r.level, `${r.id}: ${r.summary}`).toBe('ok');
  });

  it('gives a fix with every warning and failure', () => {
    const report = runDoctor(
      healthy({
        nodeVersion: 'v20.0.0',
        connection: { baseUrl: 'http://wiki.example.com', token: '' },
        dataDir: { path: '/data', writable: false },
      }),
    );
    const flagged = report.results.filter((r) => r.level === 'warn' || r.level === 'fail');
    expect(flagged.length).toBeGreaterThanOrEqual(3);
    for (const r of flagged) expect(r.fix?.length, `${r.id} has no fix`).toBeGreaterThan(5);
  });

  it('fails only on a failure, so warnings alone still let the app start', () => {
    expect(runDoctor(healthy({ connection: { baseUrl: '', token: '' } })).ok).toBe(true);
    expect(runDoctor(healthy({ dataDir: { path: '/data', writable: false } })).ok).toBe(false);
  });

  it('treats an unconfigured app as a warning and skips what needs a Confluence', () => {
    const deps = healthy({ connection: { baseUrl: '', token: '' } });
    expect(find(deps, 'confluence-config').level).toBe('warn');
    expect(find(deps, 'server-type').level).toBe('skip');
    expect(find(deps, 'tls-verification').level).toBe('skip');
  });

  it('refuses Atlassian Cloud, which the app does not support (ADR-002)', () => {
    expect(
      find(healthy({ connection: { baseUrl: 'https://acme.atlassian.net', token: 't' } }), 'server-type').level,
    ).toBe('fail');
  });

  it('warns about plain HTTP to another machine, but not to this one', () => {
    expect(
      find(healthy({ connection: { baseUrl: 'http://wiki.example.com', token: 't' } }), 'tls-verification').level,
    ).toBe('warn');
    expect(
      find(healthy({ connection: { baseUrl: 'http://localhost:8090', token: 't' } }), 'tls-verification').level,
    ).toBe('ok');
  });

  it('names the extra certificate authority it trusts, so an internal CA is visible in the report', () => {
    expect(find(healthy({ extraCaCerts: '/etc/ssl/corp-ca.pem' }), 'tls-verification').summary).toContain(
      '/etc/ssl/corp-ca.pem',
    );
  });

  it("says on Windows that the token file is protected only by the profile's permissions", () => {
    expect(find(healthy({ platform: 'win32' }), 'data-dir').summary).toMatch(/Windows profile/);
    expect(find(healthy(), 'data-dir').summary).toMatch(/readable only by you/);
  });

  it('renders one line per check and a count of each outcome', () => {
    const text = renderDoctor(runDoctor(healthy({ connection: { baseUrl: '', token: '' } })));
    expect(text).toContain('confluence-config');
    expect(text).toMatch(/\d+ passed, 1 warning\(s\), 0 failure\(s\), 2 not applicable/);
  });
});
