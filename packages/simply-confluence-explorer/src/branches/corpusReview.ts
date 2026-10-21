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
import type { AiAnswer, AiEngine } from '../ai/engine.js';
import { AiStopped } from '../ai/engine.js';
import { loadGuardRules, OutboundGuard, withWithheld } from '../ai/guard.js';
import { ManifestBuilder, mergeSummaries, summarise, type ManifestSummary } from '../ai/manifest.js';
import { cutOffNote } from '../ai/reply.js';
import { toSuggestions } from '../ai/chatQueue.js';
import { historyToSend, type SessionStore } from '../ai/sessions.js';
import { HttpError } from '../http/router.js';
import { JobRunner } from '../jobs/jobRunner.js';
import { contextCollector, leftOutNote, pagesAsContext } from '../spaces/branchContext.js';
import type { ReadPage, RetrievedContext } from '../spaces/contextRetriever.js';
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

/** What reading one batch of a thorough answer gives: its context, checked again as it is read. */
export type ReadBatch = (
  ids: string[],
  manifest: ManifestBuilder,
) => Pick<RetrievedContext, 'contextMarkdown' | 'selectedPages' | 'withheld' | 'overflow'>;

export type ThoroughRequest = {
  sessionId: string;
  spaceKey: string;
  question: string;
  /** How many pages the chat reads from. */
  corpusPages: number;
  /** The sections to read, by id, one list per request (`sectionBatches`). */
  batches: string[][];
  read: ReadBatch;
  /** The files added to the conversation, which the request combining the notes carries. */
  files: (manifest: ManifestBuilder) => string;
  weak: boolean;
};

/** What a batch's notes say when nothing in it helps, so the batch counts as read with nothing to add. */
const NOTHING = 'NOTHING RELEVANT';

const notesPrompt = (question: string): string =>
  `You are reading one batch of the sections found for a question. Other batches are read separately, and the notes from all of them are combined into the answer afterwards.
Write notes on everything in these sections that helps answer the question: facts, steps, names, numbers, and where pages disagree. Cite each note with its page and section, as [Page title › Section]. Write only the notes, with no introduction. If nothing here helps, reply with exactly: ${NOTHING}

Question: ${question}`;

const combinePrompt = (question: string, batches: number): string =>
  `Answer the question below from the notes provided, which were taken from ${batches} batches of sections of Confluence pages. Combine them into one complete answer, keeping each citation [Page title › Section] beside what it supports, and say where pages disagree. Say plainly if the notes do not answer part of the question.

Question: ${question}`;

/** The pages several batches read, each named once with every section read from it. */
function mergeRead(lists: ReadPage[][]): ReadPage[] {
  const pages = new Map<string, ReadPage>();
  for (const p of lists.flat()) {
    const seen = pages.get(p.id);
    if (!seen) pages.set(p.id, { ...p, sections: [...(p.sections ?? [])] });
    else seen.sections = [...(seen.sections ?? []), ...(p.sections ?? [])].sort((a, b) => a.index - b.index);
  }
  return [...pages.values()];
}

/** The runs of batched reviews and thorough answers, one at a time per conversation. */
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
      label:
        j.kind === 'answer'
          ? `Answering thoroughly from ${j.sections ?? 0} sections`
          : `${j.kind === 'review' ? 'Reviewing' : 'Suggesting changes to'} ${j.pages} pages`,
      processed: j.processed,
      total: j.total,
      startedAt: j.startedAt,
      current: j.currentTitle,
    }));
  }

  public start(request: CorpusReviewRequest): BatchProgress {
    this.refuseSecond(request.sessionId);
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

  /**
   * Answers a question from more sections than one request carries (design doc 0008). Each batch of
   * sections is asked for notes that answer the question, and one last request combines the notes
   * into the answer. Every batch is accounted for: its notes, a reply that nothing in it helps, or,
   * when its reply could not be read twice, its pages named in the answer as not read.
   */
  public startAnswer(request: ThoroughRequest): BatchProgress {
    this.refuseSecond(request.sessionId);
    const stopper = new AbortController();
    const job = this.jobs.start(
      {
        sessionId: request.sessionId,
        spaceKey: request.spaceKey.toUpperCase(),
        kind: 'answer',
        pages: request.corpusPages,
        sections: request.batches.reduce((n, b) => n + b.length, 0),
        total: request.batches.length,
        processed: 0,
      },
      (j) => this.runAnswer(j, request, stopper.signal),
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

  private refuseSecond(sessionId: string): void {
    const running = this.activeFor(sessionId);
    if (running)
      throw new HttpError(
        409,
        `This chat is already ${running.kind === 'answer' ? 'answering a question' : 'reviewing its pages'}. Stop that first, or wait for it.`,
      );
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
    const unread: string[] = [];
    const read = new Map<string, { id: string; title: string; version: number }>();
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
          result.pages.forEach((p) =>
            read.set(p.page.id, { id: p.page.id, title: p.page.title, version: p.page.version }),
          );
          const manifest = new ManifestBuilder();
          const context = pagesAsContext(result, manifest);
          manifest.includeTurns(
            history.length,
            history.reduce((n, t) => n + t.text.length, 0),
          );
          const batchNumber = job.processed + 1;
          // eslint-disable-next-line no-await-in-loop -- one batch at a time, as providers limit request rates
          const parsed = await (this.deps.tracer ?? noTracer).span(
            'review',
            'batch',
            { batch: batchNumber, pages: result.pages.length, withheld: result.withheld.length },
            async (span) => {
              // A reply that cannot be read is asked for once more; a batch still unread is named in
              // the answer, so its pages are not taken as reviewed.
              for (let attempt = 1; attempt <= 2; attempt++) {
                // eslint-disable-next-line no-await-in-loop -- the second attempt only follows a failed first
                const reply = await ai.chat(
                  { context, history, prompt: request.prompt, manifest: manifest.build() },
                  { spaceKey: job.spaceKey, guard, signal },
                );
                const findings = reply.cutOff ? null : request.parse(reply.text);
                span.set({ findings: findings?.length ?? 0, parsed: findings !== null, attempts: attempt });
                if (findings) return findings;
              }
              return null;
            },
          );
          if (parsed) found.push(parsed);
          else unread.push(...result.pages.map((p) => p.page.title));
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
    const now = new Date().toISOString();
    const turns: SessionTurn[] = [
      { role: 'user', text: request.shown, at: now },
      {
        role: 'assistant',
        text: `${findings.length} suggestion${findings.length === 1 ? '' : 's'} from ${job.pages} pages, read in ${batches.length} batches, added to the review queue.`,
        at: now,
        guardSummary:
          withWithheld({ blocked: [], redacted: {}, summary: 'Leak guard: checked every batch.' }, withheld).summary +
          leftOutNote({ overflow }) +
          (unread.length ? ` Not reviewed, because the AI's reply could not be read twice: ${unread.join(', ')}.` : ''),
        engine: ai.getEngine(),
        corpus: { pages: job.pages, mode: 'batched', batches: batches.length },
      },
    ];
    sessions.addTurns(session.id, turns, guard.exportState(), (list, turn) => {
      const added = toSuggestions(findings, [...read.values()], turn);
      list.push(...added);
      return { added: added.length, updated: 0, removed: 0 };
    });
  }

  private async runAnswer(job: BatchProgress, request: ThoroughRequest, signal: AbortSignal): Promise<void> {
    job.status = 'running';
    const { ai, sessions, dataDir, budget } = this.deps;
    const tracer = this.deps.tracer ?? noTracer;
    const session = sessions.get(request.sessionId);
    if (!session) throw new Error('the conversation was deleted');
    const guard = new OutboundGuard(loadGuardRules(dataDir, job.spaceKey), sessions.guardState(session.id));
    const history = historyToSend(session.turns);
    const historyChars = history.reduce((n, t) => n + t.text.length, 0);
    const notes: Array<{ batch: number; text: string }> = [];
    const summaries: ManifestSummary[] = [];
    const read: ReadPage[][] = [];
    const withheld: string[] = [];
    const overflow: string[] = [];
    const unread: string[] = [];
    let reply: AiAnswer;
    try {
      for (const [n, ids] of request.batches.entries()) {
        if (this.jobs.isCancelled(job.jobId)) return;
        const manifest = new ManifestBuilder();
        const batch = request.read(ids, manifest);
        job.currentTitle = batch.selectedPages[0]?.title;
        withheld.push(...batch.withheld);
        overflow.push(...batch.overflow);
        if (batch.selectedPages.length > 0) {
          manifest.includeTurns(history.length, historyChars);
          const built = manifest.build();
          // eslint-disable-next-line no-await-in-loop -- one batch at a time, as providers limit request rates
          const text = await tracer.span<string | null>(
            'chat',
            'thorough batch',
            { batch: n + 1, sections: ids.length, withheld: batch.withheld.length },
            async (span) => {
              // A reply that cannot be read is asked for once more; a batch still unread is named in
              // the answer, so its pages are not taken as read.
              for (let attempt = 1; attempt <= 2; attempt++) {
                // eslint-disable-next-line no-await-in-loop -- the second attempt only follows a failed first
                const got = await ai.chat(
                  { context: batch.contextMarkdown, history, prompt: notesPrompt(request.question), manifest: built },
                  { spaceKey: job.spaceKey, guard, signal },
                );
                const usable = !got.cutOff && got.text.trim().length > 0;
                span.set({ chars: got.text.length, read: usable, attempts: attempt });
                if (usable) return got.text.trim();
              }
              return null;
            },
          );
          summaries.push(summarise(built));
          if (text === null) unread.push(...batch.selectedPages.map((p) => p.title));
          else {
            read.push(batch.selectedPages);
            if (!text.includes(NOTHING)) notes.push({ batch: n + 1, text });
          }
        }
        job.processed++;
      }
      if (this.jobs.isCancelled(job.jobId)) return;
      job.combining = true;
      job.currentTitle = undefined;
      const manifest = new ManifestBuilder();
      let used = 0;
      const parts: string[] = [];
      for (const note of notes) {
        const label = `notes from batch ${note.batch}`;
        if (used + note.text.length > budget) manifest.leaveOut('notes', label, note.text.length, 'over-limit');
        else {
          used += note.text.length;
          parts.push(manifest.include('notes', label, `## Notes from batch ${note.batch}\n${note.text}`));
        }
      }
      let combined = parts.length
        ? `# Notes taken from the sections found for this question\n\n${parts.join('\n\n')}`
        : 'No batch found anything that helps answer this question.';
      const files = request.files(manifest);
      if (files) combined += `\n\n---\n\n# Files added to this conversation\n\n${files}`;
      manifest.includeTurns(history.length, historyChars);
      const built = manifest.build();
      reply = await tracer.span('chat', 'thorough combine', { notes: parts.length }, () =>
        ai.chat(
          {
            context: combined,
            history,
            prompt: combinePrompt(request.question, request.batches.length),
            manifest: built,
          },
          { spaceKey: job.spaceKey, guard, signal },
        ),
      );
      summaries.push(summarise(built));
    } catch (error) {
      // Stopping is not a failure: the run ends with nothing written and no error to report.
      if (error instanceof AiStopped || signal.aborted) return;
      job.error = errorMessage(error);
      throw error;
    } finally {
      this.stoppers.delete(job.jobId);
    }
    const matchedPages = mergeRead(read);
    const now = new Date().toISOString();
    sessions.addTurns(
      session.id,
      [
        { role: 'user', text: request.question, at: now },
        {
          role: 'assistant',
          text: reply.text,
          at: now,
          guardSummary:
            withWithheld({ ...reply.guard, summary: `${reply.guard.summary} Every batch was checked.` }, withheld)
              .summary +
            leftOutNote({ overflow }) +
            (unread.length ? ` Not read, because the AI's reply could not be read twice: ${unread.join(', ')}.` : '') +
            cutOffNote(reply.cutOff),
          sent: mergeSummaries(summaries),
          ...(reply.cutOff ? { cutOff: reply.cutOff } : {}),
          engine: ai.getEngine(),
          matchedPages,
          considered: job.sections,
          corpus: { pages: request.corpusPages, mode: 'retrieved', batches: request.batches.length },
          ...(request.weak ? { weakMatch: true } : {}),
          traceId: job.traceId,
        },
      ],
      guard.exportState(),
    );
  }
}
