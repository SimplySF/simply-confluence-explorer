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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BranchFinding, BranchItem, BranchRun } from '../api/types.js';
import { AiStopped, type AiEngine } from '../ai/engine.js';
import { GuardBlockedError } from '../ai/guard.js';
import { improvePrompt, parseRecommendationResponse } from '../ai/improve.js';
import { writePage } from '../confluence/pagePush.js';
import { HttpError } from '../http/router.js';
import { parsePage } from '../parser/convert.js';
import { gatePageForAi, type GateDeps } from '../spaces/aiGate.js';
import { collectBranch, CONTEXT_CHAR_LIMIT } from '../spaces/branchContext.js';
import { errorMessage } from '../util/errors.js';
import { within } from '../util/paths.js';
import { readJsonOrEmpty, writePrivateJson } from '../util/privateFile.js';

// Work on a page and everything under it (ADR-024). A run is kept as a file in data/branch-runs/, so
// a review queue survives a restart. Nothing is written to Confluence except a page the person
// accepted, and each write goes through the one write path, checked against the version its
// proposal was made from.

export type BranchDeps = GateDeps & {
  ai: AiEngine;
  dataDir: string;
  log: (message: string) => void;
};

const REVIEW_PROMPT = `Review this branch of Confluence documentation as a whole: the pages that follow belong together.
Find what a maintainer should fix:
- "incorrect": statements that contradict another page or look wrong
- "redundant": the same content in more than one page
- "stale": content that looks out of date (old versions, dates, retired systems)
- "structure": pages in the wrong place, or that should be split or merged
- "gap": something the branch clearly needs and does not have
Reply with JSON only, in this shape:
{"findings":[{"kind":"incorrect","pages":["Exact page title"],"detail":"what is wrong","suggestion":"what to do"}]}
Use exact page titles. Report nothing you are not confident of; an empty list is a valid answer.`;

const KINDS = new Set(['incorrect', 'redundant', 'stale', 'structure', 'gap']);
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIDABLE = new Set(['proposed', 'accepted', 'rejected', 'checked', 'check-failed', 'push-failed']);

/**
 * Reads a review's findings, or returns `null` when the answer is not the JSON asked for, so the
 * answer can be shown as text instead of being lost. A finding of a kind the prompt did not name is
 * dropped.
 *
 * @param text The AI's answer.
 */
export function parseFindings(text: string): BranchFinding[] | null {
  const json = /\{[\s\S]*\}/.exec(text);
  if (!json) return null;
  try {
    const raw = (JSON.parse(json[0]) as { findings?: unknown }).findings;
    if (!Array.isArray(raw)) return null;
    return raw.flatMap((f: unknown): BranchFinding[] => {
      const finding = (f ?? {}) as { kind?: unknown; pages?: unknown; detail?: unknown; suggestion?: unknown };
      if (typeof finding.kind !== 'string' || !KINDS.has(finding.kind) || typeof finding.detail !== 'string') return [];
      return [
        {
          kind: finding.kind as BranchFinding['kind'],
          pages: Array.isArray(finding.pages) ? finding.pages.filter((p): p is string => typeof p === 'string') : [],
          detail: finding.detail,
          suggestion: typeof finding.suggestion === 'string' ? finding.suggestion : undefined,
        },
      ];
    });
  } catch {
    // Not JSON after all: the caller keeps the answer as text.
    return null;
  }
}

export class BranchRunStore {
  private readonly dir: string;

  public constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'data', 'branch-runs');
  }

  public save(run: BranchRun): void {
    run.updatedAt = new Date().toISOString();
    writePrivateJson(this.file(run.id), run);
  }

  public get(id: string): BranchRun {
    const file = this.file(id);
    if (!fs.existsSync(file)) throw new HttpError(404, 'no such branch run');
    return readJsonOrEmpty<BranchRun>(file);
  }

  public list(spaceKey?: string, rootPageId?: string): BranchRun[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => RUN_ID.test(f.slice(0, -5)))
      .map((f) => readJsonOrEmpty<BranchRun>(path.join(this.dir, f)))
      .filter((r) => (!spaceKey || r.spaceKey === spaceKey) && (!rootPageId || r.rootPageId === rootPageId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private file(id: string): string {
    if (!RUN_ID.test(id)) throw new HttpError(400, 'invalid run id');
    return within(this.dir, `${id}.json`);
  }
}

type BranchPages = {
  spaceKey: string;
  pages: Array<{ id: string; title: string; version: number; lastModified: string; markdown: string }>;
  leftOut: string[];
};

export class BranchRunner {
  public readonly store: BranchRunStore;
  private readonly cancelled = new Set<string>();
  // A run that is still being filled is one shared object, so a decision made while proposals are
  // arriving is not overwritten by the next save of the run.
  private readonly live = new Map<string, BranchRun>();
  // Stop aborts the request in flight, not only the requests still to come (ADR-047).
  private readonly stoppers = new Map<string, AbortController>();

  public constructor(private readonly deps: BranchDeps) {
    this.store = new BranchRunStore(deps.dataDir);
  }

  public get(id: string): BranchRun {
    return this.live.get(id) ?? this.store.get(id);
  }

  /** Starts a proposal for every page in the branch. It returns at once, and the run fills as it goes. */
  public async startImprove(input: {
    spaceKey: string;
    rootPageId: string;
    focus?: string;
    instructions?: string;
  }): Promise<BranchRun> {
    // Each page is sent on its own, so the branch as a whole has no size limit.
    const { spaceKey, pages, leftOut } = await this.pagesOf(input.spaceKey, input.rootPageId, Number.MAX_SAFE_INTEGER);
    const run = newRun('improve', spaceKey, input.rootPageId, pages[0].title, {
      focus: input.focus,
      instructions: input.instructions,
      total: pages.length,
      leftOut,
      items: pages.map((p): BranchItem => ({
        pageId: p.id,
        title: p.title,
        baseVersion: p.version,
        status: 'pending',
        original: p.markdown,
      })),
    });
    this.store.save(run);
    const signal = this.begin(run);
    void this.propose(run, signal).finally(() => this.end(run));
    return run;
  }

  /** Starts a review of the branch as a whole. It returns at once. */
  public async startReview(input: { spaceKey: string; rootPageId: string; instructions?: string }): Promise<BranchRun> {
    const { spaceKey, pages, leftOut } = await this.pagesOf(input.spaceKey, input.rootPageId, CONTEXT_CHAR_LIMIT);
    const pageIds = Object.fromEntries(pages.map((p) => [p.title, p.id]));
    const run = newRun('review', spaceKey, input.rootPageId, pages[0].title, {
      instructions: input.instructions,
      total: 1,
      leftOut,
      pageIds,
    });
    this.store.save(run);
    const signal = this.begin(run);
    const context = pages
      .map(
        (p) =>
          `## [Page: ${p.title}] (version ${p.version}, last updated ${p.lastModified.slice(0, 10) || 'unknown'})\n${p.markdown}`,
      )
      .join('\n\n---\n\n');
    const prompt = input.instructions ? `${REVIEW_PROMPT}\nAlso: ${input.instructions}` : REVIEW_PROMPT;
    void this.deps.ai
      .analyzeDocument(context, prompt, `Branch: ${run.rootTitle}`, { spaceKey, signal })
      .then((answer) => {
        const findings = parseFindings(answer.text);
        if (findings) run.findings = findings;
        else run.reportText = answer.text;
        run.status = 'ready';
      })
      .catch((error: unknown) => {
        // A stopped review keeps nothing: the engine refuses even an answer that arrives afterwards.
        if (this.cancelled.has(run.id)) return;
        run.status = 'failed';
        run.error = errorMessage(error);
      })
      .finally(() => {
        if (run.status !== 'cancelled') run.processed = 1;
        this.store.save(run);
        this.end(run);
      });
    return run;
  }

  /** Stops a run at once, ending the request in flight; a run that has finished is left as it is. */
  public cancel(id: string): BranchRun {
    const run = this.get(id);
    if (run.status !== 'running') return run;
    this.cancelled.add(id);
    this.stoppers.get(id)?.abort();
    run.status = 'cancelled';
    this.store.save(run);
    return run;
  }

  /** Accepts, rejects or resets one page. An accepted page may carry the person's own edits. */
  public decide(id: string, pageId: string, decision: 'accept' | 'reject' | 'reset', proposed?: string): BranchRun {
    const run = this.get(id);
    const item = run.items.find((i) => i.pageId === pageId);
    if (!item) throw new HttpError(404, 'that page is not in this run');
    if (!DECIDABLE.has(item.status)) throw new HttpError(409, `a page that is ${item.status} cannot be decided on`);
    if (decision === 'accept') {
      if (typeof proposed === 'string') item.proposed = proposed;
      item.status = 'accepted';
    } else {
      item.status = decision === 'reject' ? 'rejected' : 'proposed';
    }
    item.message = undefined;
    this.store.save(run);
    return run;
  }

  /** Dry-runs every accepted page against Confluence. Nothing is written. */
  public check(id: string): Promise<BranchRun> {
    return this.eachAccepted(id, true);
  }

  /** Writes every accepted page. A page that was not accepted is never written. */
  public push(id: string): Promise<BranchRun> {
    return this.eachAccepted(id, false);
  }

  private async pagesOf(spaceKey: string, rootPageId: string, budget: number): Promise<BranchPages> {
    const gate = await gatePageForAi(rootPageId, spaceKey, this.deps);
    if (!gate.allowed || !gate.page) throw new HttpError(403, gate.reason ?? 'This page cannot be sent to an AI.');
    const root = { ...gate.page, markdown: parsePage(gate.page).markdown };
    const branch = await collectBranch(
      rootPageId,
      gate.spaceKey,
      this.deps,
      this.deps.dataDir,
      budget - root.markdown.length,
    );
    const leftOut = [
      ...branch.withheld.map((t) => `${t} (contains a secret)`),
      ...branch.overflow.map((t) => `${t} (over the size limit)`),
    ];
    return {
      spaceKey: gate.spaceKey,
      pages: [root, ...branch.pages.map((p) => ({ ...p.page, markdown: p.markdown }))],
      leftOut,
    };
  }

  private begin(run: BranchRun): AbortSignal {
    const stopper = new AbortController();
    this.live.set(run.id, run);
    this.stoppers.set(run.id, stopper);
    return stopper.signal;
  }

  private end(run: BranchRun): void {
    this.live.delete(run.id);
    this.stoppers.delete(run.id);
  }

  private async propose(run: BranchRun, signal: AbortSignal): Promise<void> {
    const prompt = improvePrompt(run.focus, run.instructions);
    // One page at a time: a branch can be large, and providers limit request rates.
    for (const item of run.items) {
      if (this.cancelled.has(run.id)) break;
      item.status = 'working';
      this.store.save(run);
      try {
        // eslint-disable-next-line no-await-in-loop -- one request at a time, as explained above
        const answer = await this.deps.ai.analyzeDocument(item.original ?? '', prompt, item.title, {
          spaceKey: run.spaceKey,
          signal,
        });
        const parsed = parseRecommendationResponse(answer.text);
        Object.assign(item, {
          status: 'proposed',
          proposed: parsed.improvedMarkdown,
          critique: parsed.critique,
          changelog: parsed.changelog,
          guardSummary: answer.guard.summary,
        });
      } catch (error) {
        if (error instanceof AiStopped) {
          item.status = 'pending';
          break;
        }
        item.status = error instanceof GuardBlockedError ? 'skipped' : 'failed';
        item.message = errorMessage(error);
      }
      run.processed++;
      this.store.save(run);
    }
    run.status = this.cancelled.has(run.id) ? 'cancelled' : 'ready';
    this.store.save(run);
  }

  private async eachAccepted(id: string, dryRun: boolean): Promise<BranchRun> {
    const run = this.get(id);
    const ready = dryRun ? ['accepted', 'check-failed'] : ['accepted', 'checked', 'push-failed'];
    const client = this.deps.client();
    // One page at a time, each write checked against its own base version.
    for (const item of run.items.filter((i) => ready.includes(i.status))) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one write at a time, as explained above
        const result = await writePage(client, this.deps.store, this.deps.log, {
          pageId: item.pageId,
          markdown: item.proposed ?? '',
          baseVersion: item.baseVersion,
          dryRun,
          spaceKey: run.spaceKey,
        });
        item.status = dryRun ? 'checked' : 'pushed';
        item.message = undefined;
        if (!dryRun) item.pushedVersion = result.version;
      } catch (error) {
        item.status = dryRun ? 'check-failed' : 'push-failed';
        item.message = errorMessage(error);
      }
      this.store.save(run);
    }
    return run;
  }
}

function newRun(
  kind: BranchRun['kind'],
  spaceKey: string,
  rootPageId: string,
  rootTitle: string,
  extra: Partial<BranchRun>,
): BranchRun {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind,
    spaceKey,
    rootPageId,
    rootTitle,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    processed: 0,
    total: 0,
    items: [],
    leftOut: [],
    ...extra,
  };
}
