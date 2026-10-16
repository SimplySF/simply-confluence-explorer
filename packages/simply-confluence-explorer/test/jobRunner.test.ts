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

import { describe, expect, it } from 'vitest';
import { JobRunner, type JobRecord } from '../src/jobs/jobRunner.js';

type Job = JobRecord & { note: string };

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('background jobs', () => {
  it('complete when their work finishes, and fail and are reported when it throws', async () => {
    const failures: string[] = [];
    const runner = new JobRunner<Job>('t', (job, error) => failures.push(`${job.note}: ${(error as Error).message}`));
    const ok = runner.start({ note: 'ok' }, () => Promise.resolve());
    const bad = runner.start({ note: 'bad' }, () => Promise.reject(new Error('boom')));
    await settle();
    expect(runner.get(ok.jobId)?.status).toBe('completed');
    expect(runner.get(ok.jobId)?.completedAt).toBeDefined();
    expect(runner.get(bad.jobId)?.status).toBe('failed');
    expect(failures).toEqual(['bad: boom']);
  });

  it('stay cancelled even when their work then fails', async () => {
    const runner = new JobRunner<Job>('t', () => {});
    let release!: () => void;
    const job = runner.start({ note: 'slow' }, async (j) => {
      await new Promise<void>((resolve) => (release = resolve));
      if (runner.isCancelled(j.jobId)) throw new Error('stopped');
    });
    expect(runner.cancel(job.jobId)?.status).toBe('cancelled');
    release();
    await settle();
    expect(runner.get(job.jobId)?.status).toBe('cancelled');
  });

  it('are dropped an hour after finishing, when the next job starts', async () => {
    const runner = new JobRunner<Job>('t', () => {});
    const old = runner.start({ note: 'old' }, () => Promise.resolve());
    await settle();
    old.completedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    runner.start({ note: 'new' }, () => Promise.resolve());
    expect(runner.get(old.jobId)).toBeUndefined();
  });
});
