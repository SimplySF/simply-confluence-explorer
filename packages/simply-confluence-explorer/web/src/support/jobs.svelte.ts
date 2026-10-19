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

// Work that runs on the server while the person moves around the app. It is tracked here, not in the
// component that started it, so opening another page does not lose its progress, and the header can
// show it and lead back to it.

import type { BranchRun, MetadataProgress, SyncProgress } from '../../../src/api/types.js';
import { api, branches } from './api.js';
import { pollJob } from './poll.js';
import { messageOf, toast } from './toast.svelte.js';

export type JobKind = 'summaries' | 'sync' | 'review';

export type Job = {
  kind: JobKind;
  jobId: string;
  spaceKey: string;
  /** The page the work started from, which the header opens; absent for a whole space. */
  rootPageId?: string;
  label: string;
  /** How far it has got; a total of 0 means it cannot say, as when one request is being answered. */
  processed: number;
  total: number;
  current?: string;
};

type Finished = (job: Job, status: string) => void;

const running = (status: string): boolean => status === 'running' || status === 'pending';

class Jobs {
  public list = $state<Job[]>([]);
  /** A review the header asked to open; the page view opens it once its page is on screen. */
  public requested = $state<Job | null>(null);
  private readonly stops = new Map<string, () => void>();
  private readonly listeners = new Set<Finished>();

  /** The review running on a page, if any. */
  public review(spaceKey: string, rootPageId: string): Job | undefined {
    return this.list.find((j) => j.kind === 'review' && j.spaceKey === spaceKey && j.rootPageId === rootPageId);
  }

  /** Follows a review run, so the header shows it while its dialog is closed. */
  public watchReview(run: BranchRun): void {
    if (run.status !== 'running' || this.stops.has(run.id)) return;
    const job = (r: BranchRun): Job => ({
      kind: 'review',
      jobId: r.id,
      spaceKey: r.spaceKey,
      rootPageId: r.rootPageId,
      label: `${r.kind === 'review' ? 'Review' : 'Proposals'}: ${r.rootTitle}`,
      processed: r.processed,
      total: r.kind === 'review' ? 0 : r.total,
      current: r.items.find((i) => i.status === 'working')?.title,
    });
    this.put(job(run));
    this.stops.set(
      run.id,
      pollJob(
        () => branches.get(run.id),
        {
          onProgress: (r) => this.put(job(r)),
          onFinished: (r) => {
            if (r.status !== 'cancelled')
              toast(
                `${job(r).label}: ${r.status === 'ready' ? 'ready to read' : r.status}.`,
                r.status === 'ready' ? 'success' : 'error',
              );
            this.finish(job(r), r.status);
          },
          onError: () => this.finish(job(run), 'failed'),
        },
        1000,
      ),
    );
  }

  /** The summary run for a section, or for the whole space when no page is given. */
  public summaries(spaceKey: string, rootPageId?: string): Job | undefined {
    return this.list.find((j) => j.kind === 'summaries' && j.spaceKey === spaceKey && j.rootPageId === rootPageId);
  }

  public sync(spaceKey: string): Job | undefined {
    return this.list.find((j) => j.kind === 'sync' && j.spaceKey === spaceKey);
  }

  /**
   * Calls `listener` whenever a job finishes, so what shows its results can read them again.
   *
   * @returns A function that stops the calls, for an effect to return.
   */
  public onFinished(listener: Finished): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async startSummaries(spaceKey: string, rootPageId?: string): Promise<void> {
    try {
      this.watchSummaries(await api.generateMetadata(spaceKey, rootPageId));
    } catch (e) {
      toast(`AI summaries did not start: ${messageOf(e)}`, 'error');
    }
  }

  public async startSync(spaceKey: string): Promise<void> {
    try {
      this.watchSync(await api.sync(spaceKey));
    } catch (e) {
      toast(`Sync did not start: ${messageOf(e)}`, 'error');
    }
  }

  public async stop(job: Job): Promise<void> {
    try {
      await { sync: api.cancelSync, summaries: api.cancelMetadata, review: branches.cancel }[job.kind](job.jobId);
    } catch (e) {
      toast(`Could not stop it: ${messageOf(e)}`, 'error');
      return;
    }
    this.finish(job, 'cancelled');
  }

  /** Picks up the work already running for a space, which outlives a reload of the page. */
  public resume(spaceKey: string): void {
    // Nothing running is the usual answer, and a failed check leaves nothing to show.
    api.activeMetadata(spaceKey).then(
      (p) => p && running(p.status) && this.watchSummaries(p),
      () => undefined,
    );
    api.activeSync(spaceKey).then(
      (p) => p && running(p.status) && this.watchSync(p),
      () => undefined,
    );
  }

  private watchSync(p: SyncProgress): void {
    if (this.stops.has(p.jobId)) return;
    const job = (q: SyncProgress): Job => ({
      kind: 'sync',
      jobId: q.jobId,
      spaceKey: q.spaceKey,
      label: `Syncing ${q.spaceKey}`,
      processed: q.processed,
      total: q.total,
      current: q.currentPageTitle,
    });
    this.put(job(p));
    this.stops.set(
      p.jobId,
      pollJob(
        () => api.syncStatus(p.jobId),
        {
          onProgress: (q) => this.put(job(q)),
          onFinished: (q) => {
            toast(
              q.status === 'completed'
                ? `${q.spaceKey} synced: ${q.downloadedCount} page${q.downloadedCount === 1 ? '' : 's'} downloaded, ${q.skippedCount} already current or excluded.`
                : `Sync ${q.status}${q.errors.length ? `: ${q.errors[0].error}` : ''}.`,
              q.status === 'completed' ? 'success' : 'error',
            );
            this.finish(job(q), q.status);
          },
          onError: (e) => {
            toast(`Sync stopped reporting: ${messageOf(e)}`, 'error');
            this.finish(job(p), 'failed');
          },
        },
        400,
      ),
    );
  }

  private watchSummaries(p: MetadataProgress): void {
    if (this.stops.has(p.jobId)) return;
    const job = (q: MetadataProgress): Job => ({
      kind: 'summaries',
      jobId: q.jobId,
      spaceKey: q.spaceKey,
      rootPageId: q.rootPageId,
      label: `AI summaries: ${q.rootTitle ?? q.spaceKey}`,
      processed: q.processed,
      total: q.total,
      current: q.currentPageTitle,
    });
    this.put(job(p));
    this.stops.set(
      p.jobId,
      pollJob(() => api.metadataStatus(p.jobId), {
        onProgress: (q) => this.put(job(q)),
        onFinished: (q) => {
          toast(
            q.status === 'completed'
              ? `${job(q).label}: done${q.errorCount ? `, ${q.errorCount} failed` : ''}.`
              : `${job(q).label}: ${q.status}.`,
            q.status === 'completed' ? 'success' : 'info',
          );
          this.finish(job(q), q.status);
        },
        onError: (e) => {
          toast(`${job(p).label} stopped reporting: ${messageOf(e)}`, 'error');
          this.finish(job(p), 'failed');
        },
      }),
    );
  }

  private put(job: Job): void {
    const at = this.list.findIndex((j) => j.jobId === job.jobId);
    if (at >= 0) this.list[at] = job;
    else this.list.push(job);
  }

  private finish(job: Job, status: string): void {
    this.stops.get(job.jobId)?.();
    this.stops.delete(job.jobId);
    this.list = this.list.filter((j) => j.jobId !== job.jobId);
    for (const listener of this.listeners) listener(job, status);
  }
}

export const jobs = new Jobs();
