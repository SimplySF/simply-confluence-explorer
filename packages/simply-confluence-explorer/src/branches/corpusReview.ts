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

import type { BatchProgress, BranchFinding, PageDetail, SessionTurn } from '../api/types.js';
import type { AiEngine } from '../ai/engine.js';
import { AiStopped } from '../ai/engine.js';
import { loadGuardRules, OutboundGuard, withWithheld } from '../ai/guard.js';
import { historyToSend, type SessionStore } from '../ai/sessions.js';
import { HttpError } from '../http/router.js';
import { JobRunner } from '../jobs/jobRunner.js';
import { contextCollector, leftOutNote } from '../spaces/branchContext.js';
import type { ExclusionManager } from '../spaces/exclusionManager.js';
import { errorMessage } from '../util/errors.js';
import type { LiveJob } from '../telemetry/telemetry.js';
import { noTracer, type Tracer } from '../telemetry/tracer.js';

// A review, or a request for changes, over more pages than one request can carry (ADR-051). The
// pages are grouped by the topics their metadata shares, so pages about one subject are compared in
// the same request, the groups are packed into batches that each fit, and each batch is reviewed in
// turn. The findings are merged into one answer in the conversation, which is written only when the
// whole run finishes, so a stopped or failed run leaves nothing behind (ADR-047).

/** A page as batching sees it: its size, its topics, and the directory it sits in. */
export type BatchPage = { id: string; size: number; topics: string[]; parent?: string };

/**
 * Packs pages into batches no larger than `budget`. Pages are first grouped: by their most common
 * shared topic, then, for pages with no topic left to share, by the directory they sit in. Whole
 * groups are packed in turn, so two pages of one group share a batch whenever they fit in one; a
 * group larger than a batch is split across as few as it needs.
 *
 * @param pages The pages, in the order they should be read.
 * @param budget How many characters one batch may hold.
 */
export function batchPages(pages: BatchPage[], budget: number): string[][] {
  const uses = new Map<string, number>();
  for (const p of pages) for (const t of new Set(p.topics)) uses.set(t, (uses.get(t) ?? 0) + 1);
  const groups = new Map<string, BatchPage[]>();
  for (const p of pages) {
    // The topic most pages share is the one most likely to put related pages together.
    const shared = p.topics
      .filter((t) => (uses.get(t) ?? 0) > 1)
      .sort((a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0))[0];
    const key = shared ? `topic:${shared}` : `dir:${p.parent ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const batches: string[][] = [];
  let current: string[] = [];
  let used = 0;
  const close = (): void => {
    if (current.length) batches.push(current);
    current = [];
    used = 0;
  };
  for (const group of groups.values()) {
    const size = group.reduce((n, p) => n + p.size, 0);
    // A group that would fit an empty batch but not this one starts a new batch, so it stays together.
    if (used > 0 && used + size > budget && size <= budget) close();
    for (const p of group) {
      if (used > 0 && used + p.size > budget) close();
      current.push(p.id);
      used += p.size;
    }
  }
  close();
  return batches;
}

/** Findings from several batches as one list, each said once. */
export function mergeFindings(lists: BranchFinding[][]): BranchFinding[] {
  const seen = new Set<string>();
  return lists.flat().filter((f) => {
    const key = [f.kind, [...f.pages].sort().join('|'), f.detail.trim().toLowerCase().slice(0, 80)].join('#');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type CorpusReviewDeps = {
  ai: AiEngine;
  sessions: SessionStore;
  exclusions: ExclusionManager;
  readMetadataTopics: (spaceKey: string, page: PageDetail) => string[];
  pageSize: (spaceKey: string, page: PageDetail) => number;
  dataDir: string;
  budget: number;
  log: (message: string) => void;
  tracer?: Tracer;
};

export type CorpusReviewRequest = {
  sessionId: string;
  spaceKey: string;
  pages: PageDetail[];
  /** What the conversation shows as the question, such as "Review these 312 pages for problems". */
  shown: string;
  /** What each batch asks, the same as a one-request review or request for changes would. */
  prompt: string;
  kind: BatchProgress['kind'];
  /** Reads a batch's findings, or `null` when its answer is not the JSON asked for. */
  parse: (text: string) => BranchFinding[] | null;
};

/** The runs of batched reviews, one at a time per conversation. */
export class CorpusReviews {
  private readonly jobs: JobRunner<BatchProgress>;
  private readonly stoppers = new Map<string, AbortController>();

  public constructor(private readonly deps: CorpusReviewDeps) {
    this.jobs = new JobRunner<BatchProgress>(
      'batch',
      (job, error) => deps.log(`A batched review of ${job.pages} pages failed: ${errorMessage(error)}`),
      deps.tracer,
    );
  }

  /** Batched reviews running now, for the Observability page. */
  public liveJobs(): LiveJob[] {
    return this.jobs.running().map((j) => ({
      jobId: j.jobId,
      kind: 'batch',
      label: `${j.kind === 'review' ? 'Reviewing' : 'Suggesting changes to'} ${j.pages} pages`,
      processed: j.processed,
      total: j.total,
      startedAt: j.startedAt,
      current: j.currentTitle,
    }));
  }

  public start(request: CorpusReviewRequest): BatchProgress {
    const running = this.activeFor(request.sessionId);
    if (running) throw new HttpError(409, 'This chat is already reviewing its pages. Stop that first, or wait for it.');
    const key = request.spaceKey.toUpperCase();
    const byId = new Map(request.pages.map((p) => [p.id, p]));
    const batches = batchPages(
      request.pages.map((p) => ({
        id: p.id,
        size: this.deps.pageSize(key, p),
        topics: this.deps.readMetadataTopics(key, p),
        parent: p.ancestors.at(-1)?.id,
      })),
      this.deps.budget,
    ).map((ids) => ids.map((id) => byId.get(id)!));
    const stopper = new AbortController();
    const job = this.jobs.start(
      {
        sessionId: request.sessionId,
        spaceKey: key,
        kind: request.kind,
        pages: request.pages.length,
        total: batches.length,
        processed: 0,
      },
      (j) => this.run(j, request, batches, stopper.signal),
    );
    this.stoppers.set(job.jobId, stopper);
    return job;
  }

  public get(jobId: string): BatchProgress | undefined {
    return this.jobs.get(jobId);
  }

  /** The run going on in a conversation, so a browser that reloads can show its progress again. */
  public activeFor(sessionId: string): BatchProgress | undefined {
    return this.jobs.find((j) => j.sessionId === sessionId && (j.status === 'pending' || j.status === 'running'));
  }

  public cancel(jobId: string): boolean {
    this.stoppers.get(jobId)?.abort();
    return this.jobs.cancel(jobId) !== undefined;
  }

  private async run(
    job: BatchProgress,
    request: CorpusReviewRequest,
    batches: PageDetail[][],
    signal: AbortSignal,
  ): Promise<void> {
    job.status = 'running';
    const { ai, sessions, dataDir, budget } = this.deps;
    const session = sessions.get(request.sessionId);
    if (!session) throw new Error('the conversation was deleted');
    const guard = new OutboundGuard(loadGuardRules(dataDir, job.spaceKey), sessions.guardState(session.id));
    const history = historyToSend(session.turns);
    const found: BranchFinding[][] = [];
    const withheld: string[] = [];
    const overflow: string[] = [];
    const titles = new Map<string, string>();
    try {
      for (const batch of batches) {
        if (this.jobs.isCancelled(job.jobId)) return;
        job.currentTitle = batch[0]?.title;
        // Each page is checked again here: excluded pages are left out unnamed, and a page holding a
        // secret is left out and named (contextCollector).
        const { consider, result } = contextCollector(job.spaceKey, this.deps, dataDir, budget);
        batch.forEach(consider);
        withheld.push(...result.withheld);
        overflow.push(...result.overflow);
        if (result.pages.length > 0) {
          result.pages.forEach((p) => titles.set(p.page.title, p.page.id));
          const context = result.pages.map((p) => `## [Page: ${p.page.title}]\n${p.markdown}`).join('\n\n---\n\n');
          const batchNumber = job.processed + 1;
          // eslint-disable-next-line no-await-in-loop -- one batch at a time, as providers limit request rates
          const parsed = await (this.deps.tracer ?? noTracer).span(
            'review',
            'batch',
            { batch: batchNumber, pages: result.pages.length, withheld: result.withheld.length },
            async (span) => {
              const reply = await ai.chat(
                { context, history, prompt: request.prompt },
                { spaceKey: job.spaceKey, guard, signal },
              );
              const findings = request.parse(reply.text);
              span.set({ findings: findings?.length ?? 0, parsed: findings !== null });
              return findings;
            },
          );
          found.push(parsed ?? []);
        }
        job.processed++;
      }
    } catch (error) {
      // Stopping is not a failure: the run ends with nothing written and no error to report.
      if (error instanceof AiStopped || signal.aborted) return;
      job.error = errorMessage(error);
      throw error;
    } finally {
      this.stoppers.delete(job.jobId);
    }
    const findings = mergeFindings(found);
    const named = new Set(findings.flatMap((f) => f.pages));
    const now = new Date().toISOString();
    const turns: SessionTurn[] = [
      { role: 'user', text: request.shown, at: now },
      {
        role: 'assistant',
        text: `${findings.length} suggestion${findings.length === 1 ? '' : 's'} from ${job.pages} pages, read in ${batches.length} batches. Tick the ones to queue as edits.`,
        at: now,
        guardSummary:
          withWithheld({ blocked: [], redacted: {}, summary: 'Leak guard: checked every batch.' }, withheld).summary +
          leftOutNote({ overflow }),
        engine: ai.getEngine(),
        corpus: { pages: job.pages, mode: 'batched', batches: batches.length },
        findings,
        pageIds: Object.fromEntries([...titles].filter(([title]) => named.has(title))),
      },
    ];
    sessions.addTurns(session.id, turns, guard.exportState());
  }
}
