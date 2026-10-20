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

import { noTracer, type Tracer } from '../telemetry/tracer.js';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type JobRecord = {
  jobId: string;
  status: JobStatus;
  startedAt?: string;
  completedAt?: string;
};

const KEEP_FINISHED_MS = 60 * 60 * 1000;
const KEEP_AT_MOST = 100;

/**
 * Background work whose progress a browser polls, such as syncing a space. The work starts after
 * `start` returns, and a rejection marks the job failed. Cancelling sets a flag that the work checks
 * between steps. A finished job is kept for an hour, so a late poll still gets an answer, and then
 * dropped, so the list cannot grow without end.
 */
export class JobRunner<J extends JobRecord> {
  private readonly jobs = new Map<string, J>();
  private readonly cancelled = new Set<string>();

  public constructor(
    private readonly prefix: string,
    private readonly onFailure: (job: J, error: unknown) => void,
    private readonly tracer: Tracer = noTracer,
  ) {}

  public start(fields: Omit<J, 'jobId' | 'status'>, work: (job: J) => Promise<void>): J {
    this.prune();
    const jobId = `${this.prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const job = { ...fields, jobId, status: 'pending', startedAt: new Date().toISOString() } as J;
    this.jobs.set(jobId, job);
    // Each job is a trace of its own, linked to the request that started it, because it outlives it.
    const startedBy = this.tracer.current()?.traceId;
    this.tracer
      .span('job', this.prefix, { jobId, ...(startedBy ? { startedBy } : {}) }, () => work(job), { root: true })
      .catch((error: unknown) => {
        if (job.status === 'cancelled') return;
        job.status = 'failed';
        this.onFailure(job, error);
      })
      .finally(() => {
        if (job.status === 'pending' || job.status === 'running') job.status = 'completed';
        job.completedAt ??= new Date().toISOString();
      });
    return job;
  }

  public get(jobId: string): J | undefined {
    return this.jobs.get(jobId);
  }

  public find(match: (job: J) => boolean): J | undefined {
    return [...this.jobs.values()].find(match);
  }

  /** The jobs still running, for the Observability page. */
  public running(): J[] {
    return [...this.jobs.values()].filter((j) => j.status === 'pending' || j.status === 'running');
  }

  public cancel(jobId: string): J | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    this.cancelled.add(jobId);
    job.status = 'cancelled';
    return job;
  }

  public isCancelled(jobId: string): boolean {
    return this.cancelled.has(jobId);
  }

  private prune(): void {
    const now = Date.now();
    const finished = [...this.jobs.values()].filter((j) => j.completedAt);
    for (const j of finished) {
      if (now - Date.parse(j.completedAt!) > KEEP_FINISHED_MS) this.drop(j.jobId);
    }
    const excess = this.jobs.size - KEEP_AT_MOST;
    if (excess > 0) finished.slice(0, excess).forEach((j) => this.drop(j.jobId));
  }

  private drop(jobId: string): void {
    this.jobs.delete(jobId);
    this.cancelled.delete(jobId);
  }
}
