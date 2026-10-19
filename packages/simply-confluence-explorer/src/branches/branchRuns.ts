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
import type {
  BranchFinding,
  BranchFix,
  BranchItem,
  BranchRun,
  PageDetail,
  PageTreeNode,
  ReviewAspect,
  ReviewSource,
} from '../api/types.js';
import { AiStopped, type AiEngine } from '../ai/engine.js';
import { GuardBlockedError } from '../ai/guard.js';
import { applyPrompt, parseRecommendationResponse } from '../ai/improve.js';
import { writePage } from '../confluence/pagePush.js';
import { HttpError } from '../http/router.js';
import { gatePageForAi, type GateDeps } from '../spaces/aiGate.js';
import { CONTEXT_CHAR_LIMIT, contextCollector } from '../spaces/branchContext.js';
import { tagsOf } from '../spaces/tags.js';
import { errorMessage } from '../util/errors.js';
import { within } from '../util/paths.js';
import { readJsonOrEmpty, writePrivateJson } from '../util/privateFile.js';

// Reviews of a set of pages, and the edits staged from the suggestions a person chose (ADR-024,
// ADR-046). A run is kept as a file in data/branch-runs/, so a queue survives a restart. Nothing is
// written to Confluence except a page the person accepted, and each write goes through the one write
// path, checked against the version its edit was made from.

export type BranchDeps = GateDeps & {
  ai: AiEngine;
  dataDir: string;
  log: (message: string) => void;
};

/** What each aspect a person can tick asks the review to find, as the finding kind it reports. */
const ASPECTS: Record<ReviewAspect, string> = {
  accuracy: '"incorrect": statements that are wrong, or that contradict another page',
  repetition: '"redundant": the same content in more than one place',
  staleness: '"stale": content that looks out of date, such as old versions, dates or retired systems',
  clarity: '"clarity": writing that is hard to follow, ambiguous or badly worded',
  depth: '"depth": missing prerequisites, steps, context, commands or expected results',
  structure: '"structure": headings, order or formatting within a page that should change',
  operations: '"operations": procedures without pre-checks, rollback, escalation or a way to verify them',
};
export const REVIEW_ASPECTS = Object.keys(ASPECTS) as ReviewAspect[];

/** Kinds that no edit of one existing page can fix: they are shown, never applied. */
export const NOT_EDITABLE = new Set<BranchFinding['kind']>(['placement', 'gap']);

/**
 * The instruction for a review of one page, or of several read together.
 *
 * @param aspects What to look for.
 * @param pageCount How many pages are sent.
 * @param instructions The person's own notes, if any.
 */
export function reviewPrompt(aspects: ReviewAspect[], pageCount: number, instructions?: string): string {
  const kinds = aspects.map((a) => `- ${ASPECTS[a]}`);
  if (pageCount > 1)
    kinds.push(
      '- "placement": a page in the wrong place, or one that should be split or merged with another',
      '- "gap": a page these pages clearly need that does not exist',
    );
  const what =
    pageCount > 1
      ? 'the Confluence pages that follow as a set: they are meant to be read together'
      : 'the Confluence page that follows';
  return `Review ${what}.
Find what a maintainer should fix, of these kinds only:
${kinds.join('\n')}
Reply with JSON only, in this shape:
{"findings":[{"kind":"incorrect","pages":["Exact page title"],"detail":"what is wrong","suggestion":"what to do"}]}
Use exact page titles, and name every page a finding is about. Report nothing you are not confident of; an empty list is a valid answer.${instructions ? `\nAlso: ${instructions}` : ''}`;
}

const KINDS = new Set<string>([
  'incorrect',
  'redundant',
  'stale',
  'clarity',
  'depth',
  'structure',
  'operations',
  'placement',
  'gap',
]);
/** How many pages one review may read: enough for a section or a tag, few enough to stay within one request. */
export const MAX_REVIEW_PAGES = 50;
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
    if (!fs.existsSync(file)) throw new HttpError(404, 'no such review run');
    return readJsonOrEmpty<BranchRun>(file);
  }

  /** The runs in a space, newest first, optionally only those whose pages were chosen the same way. */
  public list(spaceKey?: string, source?: ReviewSource): BranchRun[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => RUN_ID.test(f.slice(0, -5)))
      .map((f) => readJsonOrEmpty<BranchRun>(path.join(this.dir, f)))
      .filter((r) => (!spaceKey || r.spaceKey === spaceKey) && (!source || sameSource(sourceOf(r), source)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private file(id: string): string {
    if (!RUN_ID.test(id)) throw new HttpError(400, 'invalid run id');
    return within(this.dir, `${id}.json`);
  }
}

type ReviewPage = { id: string; title: string; version: number; lastModified: string; markdown: string };

/** How a run's pages were chosen; a run saved before reviews had a source reviewed a whole section. */
export const sourceOf = (run: BranchRun): ReviewSource => run.source ?? { kind: 'section', rootPageId: run.rootPageId };

const sameSource = (a: ReviewSource, b: ReviewSource): boolean =>
  a.kind === b.kind &&
  (a.kind === 'tag' ? a.tag === (b as { tag: string }).tag : a.rootPageId === (b as { rootPageId: string }).rootPageId);

/** Suggestions the server stored, ready to be staged as edits. */
export type StagedOrigin = {
  spaceKey: string;
  rootPageId: string;
  rootTitle: string;
  source?: ReviewSource;
  instructions?: string;
  findings: BranchFinding[];
  /** The pages that were read, by title, so a suggestion's pages can be found. */
  pageIds: Record<string, string>;
  fromRunId?: string;
  fromSessionId?: string;
};

export type ReviewInput = {
  spaceKey: string;
  source: ReviewSource;
  pageIds: string[];
  aspects: ReviewAspect[];
  instructions?: string;
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

  /**
   * Starts a review of the chosen pages, read together in one request. It returns at once. Every page
   * must belong to the source it was chosen from and pass the exclusion rules; a page holding a
   * secret, or beyond the size limit, is left out and named.
   */
  public async startReview(input: ReviewInput): Promise<BranchRun> {
    await this.checkMembership(input);
    const { pages, leftOut } = await this.pagesFor(input.spaceKey, input.pageIds, CONTEXT_CHAR_LIMIT);
    if (pages.length === 0) throw new HttpError(422, `None of the chosen pages could be sent: ${leftOut.join(', ')}.`);
    const { source } = input;
    const rootPageId = source.kind === 'tag' ? '' : source.rootPageId;
    const title =
      source.kind === 'tag' ? `#${source.tag}` : (pages.find((p) => p.id === rootPageId)?.title ?? pages[0].title);
    const run = newRun('review', input.spaceKey, rootPageId, title, {
      source: input.source,
      aspects: input.aspects,
      instructions: input.instructions,
      total: 1,
      leftOut,
      pageIds: Object.fromEntries(pages.map((p) => [p.title, p.id])),
    });
    this.store.save(run);
    const signal = this.begin(run);
    const context = pages
      .map(
        (p) =>
          `## [Page: ${p.title}] (version ${p.version}, last updated ${p.lastModified.slice(0, 10) || 'unknown'})\n${p.markdown}`,
      )
      .join('\n\n---\n\n');
    const prompt = reviewPrompt(input.aspects, pages.length, input.instructions);
    void this.deps.ai
      .analyzeDocument(context, prompt, title, { spaceKey: input.spaceKey, signal })
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

  /**
   * Stages edits from a finished review's suggestions.
   *
   * @param reviewId The review whose suggestions to apply.
   * @param chosen The indexes of the chosen suggestions in the review's findings.
   */
  public apply(reviewId: string, chosen: number[]): Promise<BranchRun> {
    const review = this.get(reviewId);
    if (review.kind !== 'review' || review.status !== 'ready' || !review.findings)
      throw new HttpError(409, 'only a finished review with suggestions can be applied');
    return this.stageEdits(
      {
        spaceKey: review.spaceKey,
        rootPageId: review.rootPageId,
        rootTitle: review.rootTitle,
        source: sourceOf(review),
        instructions: review.instructions,
        findings: review.findings,
        pageIds: review.pageIds ?? {},
        fromRunId: review.id,
      },
      chosen,
    );
  }

  /**
   * Stages an edit of each page the chosen suggestions name, carrying only those suggestions. The
   * suggestions come from where the server stored them, a review or a chat's answer, never from the
   * browser, and each page is checked again and edited from its current version. It returns at once,
   * and the run fills as it goes.
   *
   * @param origin The stored suggestions, the pages they may name by title, and where they came from.
   * @param chosen The indexes of the chosen suggestions.
   */
  public async stageEdits(origin: StagedOrigin, chosen: number[]): Promise<BranchRun> {
    const { findings } = origin;
    if (chosen.length === 0 || chosen.some((i) => !Number.isInteger(i) || i < 0 || i >= findings.length))
      throw new HttpError(400, 'choose suggestions from the list');
    const picked = [...new Set(chosen)].map((i) => findings[i]);
    if (picked.some((f) => NOT_EDITABLE.has(f.kind)))
      throw new HttpError(400, 'a suggestion to move, split, merge or write a page cannot be applied as an edit');
    const fixesFor = new Map<string, BranchFix[]>();
    for (const f of picked) {
      for (const title of f.pages) {
        const id = origin.pageIds[title];
        if (!id) continue;
        const fix = {
          kind: f.kind,
          detail: f.detail,
          suggestion: f.suggestion,
          otherPages: f.pages.filter((p) => p !== title),
        };
        fixesFor.set(id, [...(fixesFor.get(id) ?? []), fix]);
      }
    }
    if (fixesFor.size === 0) throw new HttpError(400, 'the chosen suggestions name no page that was read');
    // Each page is sent on its own, so the pages as a whole have no size limit.
    const { pages, leftOut } = await this.pagesFor(
      origin.spaceKey,
      [...fixesFor.keys()],
      Number.MAX_SAFE_INTEGER,
      true,
    );
    if (pages.length === 0) throw new HttpError(422, `None of the pages can be edited: ${leftOut.join(', ')}.`);
    const run = newRun('improve', origin.spaceKey, origin.rootPageId, origin.rootTitle, {
      source: origin.source,
      fromRunId: origin.fromRunId,
      fromSessionId: origin.fromSessionId,
      instructions: origin.instructions,
      total: pages.length,
      leftOut,
      items: pages.map((p): BranchItem => ({
        pageId: p.id,
        title: p.title,
        baseVersion: p.version,
        status: 'pending',
        original: p.markdown,
        fixes: fixesFor.get(p.id),
      })),
    });
    this.store.save(run);
    const signal = this.begin(run);
    void this.propose(run, signal).finally(() => this.end(run));
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

  /** Refuses a page that the source it was chosen from does not hold. */
  private async checkMembership({ spaceKey, source, pageIds }: ReviewInput): Promise<void> {
    if (source.kind === 'page') {
      if (pageIds.length !== 1 || pageIds[0] !== source.rootPageId)
        throw new HttpError(400, 'a page review reads only its own page');
      return;
    }
    if (source.kind !== 'tag') {
      // The synced copy when the section is on disk, otherwise Confluence's own tree.
      const flat = (nodes: PageTreeNode[]): PageTreeNode[] => nodes.flatMap((n) => [n, ...flat(n.children)]);
      const below = this.deps.store.readPage(spaceKey, source.rootPageId)
        ? this.deps.store.descendants(spaceKey, source.rootPageId)
        : flat((await this.deps.client().getPageTree(spaceKey, source.rootPageId))[0]?.children ?? []);
      const section = new Set([source.rootPageId, ...below.map((n) => n.id)]);
      if (pageIds.some((id) => !section.has(id))) throw new HttpError(400, 'a chosen page is not in the section');
      return;
    }
    const { tag } = source;
    for (const id of pageIds) {
      const page = this.deps.store.readPage(spaceKey, id);
      if (!page || !tagsOf(page, this.deps.store.readMetadata(spaceKey, id)).includes(tag))
        throw new HttpError(400, `a chosen page does not carry the tag ${tag}, as synced`);
    }
  }

  /**
   * The chosen pages that may be sent, each checked against the exclusion rules. A page the browser
   * could not have been offered, because it is excluded or in another space, refuses the whole run;
   * a page holding a secret or beyond the size limit is left out and named.
   *
   * @param spaceKey The space every page must be in.
   * @param ids The chosen pages.
   * @param budget How many characters the pages may take together.
   * @param skipExcluded Leave out, without naming, a page excluded since it was chosen, rather than refusing.
   */
  private async pagesFor(
    spaceKey: string,
    ids: string[],
    budget: number,
    skipExcluded = false,
  ): Promise<{ pages: ReviewPage[]; leftOut: string[] }> {
    const { consider, result } = contextCollector(spaceKey, this.deps, this.deps.dataDir, budget);
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop -- pages are checked in the order they were chosen
      const gate = await gatePageForAi(id, spaceKey, this.deps);
      if (gate.page && gate.page.spaceKey.toUpperCase() !== spaceKey)
        throw new HttpError(400, `a chosen page is not in ${spaceKey}`);
      if (!gate.allowed || !gate.page) {
        if (skipExcluded && gate.page) continue;
        throw new HttpError(403, gate.reason ?? 'A chosen page cannot be sent to an AI.');
      }
      consider(gate.page);
    }
    const page = (p: PageDetail, markdown: string): ReviewPage => ({
      id: p.id,
      title: p.title,
      version: p.version,
      lastModified: p.lastModified,
      markdown,
    });
    return {
      pages: result.pages.map((p) => page(p.page, p.markdown)),
      leftOut: [
        ...result.withheld.map((title) => `${title} (contains a secret)`),
        ...result.overflow.map((title) => `${title} (over the size limit)`),
      ],
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
    // One page at a time: a section can be large, and providers limit request rates.
    for (const item of run.items) {
      if (this.cancelled.has(run.id)) break;
      item.status = 'working';
      this.store.save(run);
      try {
        const prompt = applyPrompt(item.fixes ?? [], run.instructions);
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
