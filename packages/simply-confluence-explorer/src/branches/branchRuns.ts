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
  QueuedSuggestion,
  ReviewAspect,
} from '../api/types.js';
import { AiStopped, type AiEngine } from '../ai/engine.js';
import { GuardBlockedError } from '../ai/guard.js';
import {
  applyPrompt,
  freshnessPrompt,
  parseRecommendationResponse,
  parseVerdicts,
  unappliedOf,
} from '../ai/improve.js';
import { writePage } from '../confluence/pagePush.js';
import { HttpError } from '../http/router.js';
import { stripFrontmatter } from '../parser/convert.js';
import { toEditForm } from '../parser/editForm.js';
import { EXCLUDED_MESSAGE, gatePageForAi, type GateDeps } from '../spaces/aiGate.js';
import { imagesFor } from '../spaces/attachments.js';
import { loadSpaceSettings } from '../spaces/spaceSettings.js';
import { errorMessage } from '../util/errors.js';
import { pause } from '../util/pause.js';
import { within } from '../util/paths.js';
import { readJsonOrEmpty, writePrivateJson } from '../util/privateFile.js';
import { acceptedText, changedSince, partsOf, refreshChanges } from './pageChanges.js';

// Reviews of a set of pages, and the edits staged from the suggestions a person chose (ADR-024,
// ADR-046). A run is kept as a file in data/branch-runs/, so a queue survives a restart. Nothing is
// written to Confluence except the changes a person accepted (ADR-059), and each write goes through
// the one write path, checked against the version its edit was made from.

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

/** Says what a page's frontmatter is for, so a review never suggests writing it into the page. */
export const RECORD_NOTE =
  "The YAML frontmatter at the top of each page is the app's record of it (id, version, author, dates, address, breadcrumbs). Use it to judge whether a page is out of date, but never suggest putting it into a page.";

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
Use exact page titles, and name every page a finding is about. Report nothing you are not confident of; an empty list is a valid answer.
${RECORD_NOTE}${instructions ? `\nAlso: ${instructions}` : ''}`;
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
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIDABLE = new Set(['proposed', 'accepted', 'rejected', 'checked', 'check-failed', 'push-failed']);
/** A page whose edit can be made again from the page as Confluence holds it now. */
const REDOABLE = new Set(['failed', 'check-failed', 'push-failed']);
/** A page whose changes are decided, with at least one accepted, so it can be staged and pushed. */
const READY = ['accepted', 'checked', 'push-failed'];

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

  private file(id: string): string {
    if (!RUN_ID.test(id)) throw new HttpError(400, 'invalid run id');
    return within(this.dir, `${id}.json`);
  }
}

/** A chat's suggestions picked to become edits, read from where the server stored them. */
export type RecommendOrigin = {
  spaceKey: string;
  rootPageId: string;
  rootTitle: string;
  fromSessionId: string;
  suggestions: QueuedSuggestion[];
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
    const run = this.live.get(id) ?? this.store.get(id);
    if (run.status === 'running' && !this.live.has(id)) this.interrupted(run);
    // A run saved before edits were decided change by change has an edit but no changes yet.
    for (const item of run.items)
      if (item.proposed !== undefined && item.changes === undefined) {
        item.suggested ??= item.proposed;
        if (DECIDABLE.has(item.status)) refreshChanges(item);
      }
    return run;
  }

  /**
   * Makes an edit of each page the picked suggestions name, carrying only those suggestions. The
   * suggestions come from where the server stored them, never from the browser. It returns at once,
   * and the run fills as it goes: each page is read from Confluence first, and a suggestion made
   * before the page changed is checked again before it is applied (ADR-061).
   *
   * @param origin The chat and its picked suggestions.
   */
  public async recommend(origin: RecommendOrigin): Promise<BranchRun> {
    const picked = origin.suggestions;
    if (picked.length === 0) throw new HttpError(400, 'choose suggestions from the list');
    if (picked.some((f) => NOT_EDITABLE.has(f.kind)))
      throw new HttpError(400, 'a suggestion to move, split, merge or write a page cannot be applied as an edit');
    const fixesFor = new Map<string, { title: string; fixes: BranchFix[] }>();
    for (const f of picked) {
      for (const title of f.pages) {
        const id = f.pageIds[title];
        if (!id) continue;
        const fix: BranchFix = {
          kind: f.kind,
          detail: f.detail,
          suggestion: f.suggestion,
          otherPages: f.pages.filter((p) => p !== title),
          suggestionId: f.id,
          seenVersion: f.seenVersions[id],
        };
        fixesFor.set(id, { title, fixes: [...(fixesFor.get(id)?.fixes ?? []), fix] });
      }
    }
    if (fixesFor.size === 0) throw new HttpError(400, 'the chosen suggestions name no page that was read');
    // A page excluded since it was suggested is left out without being named.
    for (const id of [...fixesFor.keys()]) {
      // eslint-disable-next-line no-await-in-loop -- pages are checked in turn
      const gate = await gatePageForAi(id, origin.spaceKey, this.deps);
      if (!gate.allowed || gate.page?.spaceKey.toUpperCase() !== origin.spaceKey) fixesFor.delete(id);
    }
    if (fixesFor.size === 0) throw new HttpError(422, 'None of the pages these suggestions name can be edited.');
    const run = newRun('improve', origin.spaceKey, origin.rootPageId, origin.rootTitle, {
      fromSessionId: origin.fromSessionId,
      total: fixesFor.size,
      leftOut: [],
      items: [...fixesFor].map(([pageId, { title, fixes }]): BranchItem => ({
        pageId,
        title,
        baseVersion: 0,
        status: 'pending',
        fixes,
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

  /**
   * Accepts or rejects one change of a page's edit, or with `undo` leaves it undecided again.
   *
   * @param id The run.
   * @param pageId The page.
   * @param changeId The change, as the run lists it.
   * @param decision What the person decided.
   */
  public decideChange(id: string, pageId: string, changeId: string, decision: 'accept' | 'reject' | 'undo'): BranchRun {
    return this.edit(id, pageId, (item) => {
      const change = item.changes?.find((c) => c.id === changeId);
      if (!change) throw new HttpError(404, 'that change is not in this edit; it may have changed since');
      if (decision === 'accept' && change.problem) throw new HttpError(409, change.problem);
      const decisions = { ...item.decisions };
      if (decision === 'undo') delete decisions[changeId];
      else decisions[changeId] = decision === 'accept' ? 'accepted' : 'rejected';
      item.decisions = decisions;
    });
  }

  /** Accepts or rejects every change of a page's edit at once. */
  public decideAll(id: string, pageId: string, decision: 'accept' | 'reject'): BranchRun {
    return this.edit(id, pageId, (item) => {
      const usable = (item.changes ?? []).filter((c) => decision === 'reject' || !c.problem);
      item.decisions = Object.fromEntries(usable.map((c) => [c.id, decision === 'accept' ? 'accepted' : 'rejected']));
    });
  }

  /** Saves the person's own edits to a page's working text; changes they touch are asked again. */
  public setText(id: string, pageId: string, text: string): BranchRun {
    return this.edit(id, pageId, (item) => {
      item.proposed = stripFrontmatter(text);
    });
  }

  /** Puts a revision the chat proposed into a page's working text; its changes count as the AI's. */
  public refine(id: string, pageId: string, text: string): BranchRun {
    return this.edit(id, pageId, (item) => {
      item.proposed = stripFrontmatter(text).trim();
      item.refined = item.proposed;
    });
  }

  /** Puts a page's working text back to the model's edit and clears every decision on it. */
  public reset(id: string, pageId: string): BranchRun {
    return this.edit(id, pageId, (item) => {
      item.proposed = item.suggested;
      item.decisions = {};
      delete item.refined;
    });
  }

  /**
   * Makes a page's edit again from the page as Confluence holds it now, with the same suggestions,
   * for an edit that failed or was refused because the page changed since it was made.
   */
  public redo(id: string, pageId: string): BranchRun {
    const run = this.get(id);
    const item = run.items.find((i) => i.pageId === pageId);
    if (!item) throw new HttpError(404, 'that page is not in this run');
    if (run.status === 'running') throw new HttpError(409, 'wait for the run to finish before making an edit again');
    if (!REDOABLE.has(item.status)) throw new HttpError(409, `a page that is ${item.status} is not made again`);
    for (const key of Object.keys(item) as Array<keyof BranchItem>)
      if (!['pageId', 'title', 'fixes'].includes(key)) delete item[key];
    Object.assign(item, { baseVersion: 0, status: 'pending' });
    run.status = 'running';
    run.processed = Math.max(0, run.processed - 1);
    this.store.save(run);
    const signal = this.begin(run);
    void this.propose(run, signal).finally(() => this.end(run));
    return run;
  }

  /**
   * Picks a page to be pushed, or puts it back. Only a page whose every change is decided, with at
   * least one accepted, can be picked.
   */
  public stage(id: string, pageId: string, staged: boolean): BranchRun {
    const run = this.get(id);
    const item = run.items.find((i) => i.pageId === pageId);
    if (!item) throw new HttpError(404, 'that page is not in this run');
    if (staged && !READY.includes(item.status))
      throw new HttpError(409, 'decide every change, accepting at least one, before staging the page');
    item.staged = staged;
    this.store.save(run);
    return run;
  }

  /** Dry-runs each staged page, or the staged pages named, against Confluence. Nothing is written. */
  public check(id: string, pageIds?: string[]): Promise<BranchRun> {
    return this.eachStaged(id, true, pageIds);
  }

  /**
   * Writes the accepted changes of each staged page, or of the staged pages named. A change that was
   * not accepted, and a page that was not staged, is never written.
   */
  public push(id: string, pageIds?: string[]): Promise<BranchRun> {
    return this.eachStaged(id, false, pageIds);
  }

  private edit(id: string, pageId: string, change: (item: BranchItem) => void): BranchRun {
    const run = this.get(id);
    const item = run.items.find((i) => i.pageId === pageId);
    if (!item) throw new HttpError(404, 'that page is not in this run');
    if (!DECIDABLE.has(item.status) || item.proposed === undefined)
      throw new HttpError(409, `a page that is ${item.status} cannot be decided on`);
    change(item);
    refreshChanges(item);
    item.message = undefined;
    item.staged = false;
    this.store.save(run);
    return run;
  }

  /**
   * Settles a run saved as running that no request is filling, because the app stopped while it
   * was: its unfinished pages are marked failed, with why, so each can be made again with Redo.
   */
  private interrupted(run: BranchRun): void {
    for (const item of run.items)
      if (['pending', 'checking', 'working'].includes(item.status)) {
        delete item.writing;
        item.status = 'failed';
        item.message = 'The app stopped while this edit was being written.';
      }
    run.status = run.kind === 'review' ? 'failed' : 'ready';
    this.store.save(run);
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
    // A stopped run can be started again by Redo, which must not find it still stopped.
    this.cancelled.delete(run.id);
  }

  /**
   * Writes the pending pages' edits, as many at once as the AI may take requests (`ai.parallel`, the
   * setting the AI index uses too). Stop ends every request in flight, and each worker takes no new
   * page once the run is stopped.
   */
  private async propose(run: BranchRun, signal: AbortSignal): Promise<void> {
    const pending = run.items.filter((i) => i.status === 'pending');
    const stopped = (): boolean => this.cancelled.has(run.id) || signal.aborted;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pending.length && !stopped()) {
        const item = pending[next++];
        // eslint-disable-next-line no-await-in-loop -- each worker writes one page at a time
        await this.proposeOne(run, item, signal);
        // eslint-disable-next-line no-await-in-loop -- lets other work run between pages
        await pause();
      }
    };
    const workers = Math.max(1, Math.min(this.deps.ai.parallel?.() ?? 1, pending.length));
    await Promise.all(Array.from({ length: workers }, worker));
    run.status = this.cancelled.has(run.id) ? 'cancelled' : 'ready';
    this.store.save(run);
  }

  /** Writes one page's edit, recording each step it takes so the person can follow it. */
  private async proposeOne(run: BranchRun, item: BranchItem, signal: AbortSignal): Promise<void> {
    try {
      if (item.original === undefined && !(await this.freshen(run, item, signal))) {
        step(item, item.message ?? 'Not edited.');
        run.processed++;
        this.store.save(run);
        return;
      }
      item.status = 'working';
      step(item, `Writing the edit, applying ${plural(item.fixes?.length ?? 0, 'suggestion')}`);
      this.store.save(run);
      const prompt = applyPrompt(item.fixes ?? [], run.instructions) + this.attachmentsNote(run.spaceKey, item.pageId);
      const seen = this.imagesOf(run.spaceKey, item.pageId);
      if (seen.report.found) item.images = seen.report;
      const answer = await this.deps.ai.analyzeDocument(item.original ?? '', prompt, item.title, {
        spaceKey: run.spaceKey,
        signal,
        ...(seen.images.length ? { images: seen.images } : {}),
        // Kept in memory only, for the screen to show while the edit is written.
        onText: (text) => (item.writing = { chars: text.length, tail: text.slice(-WRITING_TAIL) }),
      });
      const parsed = parseRecommendationResponse(answer.text);
      const edit = stripFrontmatter(parsed.improvedMarkdown).trim();
      Object.assign(item, {
        suggested: edit,
        proposed: edit,
        critique: parsed.critique,
        changelog: parsed.changelog,
        guardSummary: answer.guard.summary,
      });
      refreshChanges(item);
      if (item.changes?.length === 0) {
        // An edit that changes nothing has nothing to decide or push, so it is not left waiting.
        item.status = 'skipped';
        item.message = `No change written: ${unappliedOf(parsed.critique) ?? 'the AI found nothing it could change in the page’s text.'}`;
        step(item, item.message);
      } else step(item, `Ready to decide: ${plural(item.changes?.length ?? 0, 'change')}`);
    } catch (error) {
      delete item.writing;
      if (error instanceof AiStopped) {
        item.status = 'pending';
        step(item, 'Stopped');
        return;
      }
      item.status = error instanceof GuardBlockedError ? 'skipped' : 'failed';
      item.message = errorMessage(error);
      step(item, `${item.status === 'skipped' ? 'Not sent' : 'Failed'}: ${item.message}`);
    }
    delete item.writing;
    run.processed++;
    this.store.save(run);
  }

  /** The page's images, sent with its edit request only when the space chose to send them (ADR-066). */
  private imagesOf(spaceKey: string, pageId: string): ReturnType<typeof imagesFor> {
    const page = this.deps.store.readPage(spaceKey, pageId);
    const choice = loadSpaceSettings(this.deps.dataDir, spaceKey).images;
    return imagesFor((key, p) => this.deps.store.attachments.of(key, p), choice, page ? [{ spaceKey, page }] : []);
  }

  /** The page's text attachments, for the edit model to read but never edit (ADR-066). */
  private attachmentsNote(spaceKey: string, pageId: string): string {
    const page = this.deps.store.readPage(spaceKey, pageId);
    const text = page ? this.deps.store.attachments.of(spaceKey, page).text : '';
    return text
      ? `\n\nThe page's attachments, to read for context only; never edit them or copy them into the page:${text}`
      : '';
  }

  /**
   * Reads a page from Confluence before its edit is made, updates the copy on this machine when the
   * page is newer, and asks again about each suggestion made before the page changed: one already
   * done, or no longer relevant, is not applied (ADR-061). Returns false when nothing is left to edit.
   */
  private async freshen(run: BranchRun, item: BranchItem, signal: AbortSignal): Promise<boolean> {
    item.status = 'checking';
    step(item, 'Reading the page from Confluence');
    this.store.save(run);
    const page = await this.deps.client().getPageDetail(item.pageId);
    const key = run.spaceKey;
    if (page.spaceKey.toUpperCase() !== key) throw new Error(`this page is no longer in ${key}`);
    if (this.deps.exclusions.isPageExcluded(page, key)) {
      item.status = 'skipped';
      item.message = EXCLUDED_MESSAGE;
      return false;
    }
    const local = this.deps.store.readPage(key, item.pageId);
    if (local && page.version > local.version) this.deps.store.refreshPage(key, page);
    const now = editOf(page);
    const changed = (f: BranchFix): boolean =>
      f.seenVersion !== undefined ? page.version > f.seenVersion : !!local && page.version > local.version;
    const stale = (item.fixes ?? []).filter(changed);
    let verdicts: NonNullable<BranchItem['freshness']>['verdicts'] = [];
    if (stale.length > 0) {
      step(item, `The page changed since it was suggested: checking ${plural(stale.length, 'suggestion')} still apply`);
      this.store.save(run);
      const before = local && page.version > local.version ? editOf(local).original : undefined;
      const answer = await this.deps.ai.analyzeDocument(
        now.original ?? '',
        freshnessPrompt(stale, changedSince(before, now.original ?? '')),
        item.title,
        { spaceKey: key, signal },
      );
      verdicts = parseVerdicts(answer.text, stale);
      for (const v of verdicts) step(item, `${VERDICT[v.verdict]}: ${v.detail}${v.why ? ` (${v.why})` : ''}`);
    }
    // Matched by position among the suggestions asked about, so two worded alike are judged apart.
    const dropped = new Set(stale.filter((_, i) => verdicts[i]?.verdict !== 'applies'));
    item.freshness = { version: page.version, verdicts };
    item.fixes = (item.fixes ?? []).filter((f) => !dropped.has(f));
    Object.assign(item, { baseVersion: page.version, ...now });
    if (item.fixes.length > 0) return true;
    item.status = 'skipped';
    item.message = 'Nothing left to change: the page already does what was suggested, or it no longer applies.';
    return false;
  }

  private async eachStaged(id: string, dryRun: boolean, pageIds?: string[]): Promise<BranchRun> {
    const run = this.get(id);
    const ready = dryRun ? ['accepted', 'checked', 'check-failed'] : READY;
    const chosen = (i: BranchItem): boolean =>
      !!i.staged && ready.includes(i.status) && (!pageIds || pageIds.includes(i.pageId));
    const client = this.deps.client();
    // One page at a time, each write checked against its own base version.
    for (const item of run.items.filter(chosen)) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one write at a time, as explained above
        const result = await writePage(client, this.deps.store, this.deps.log, {
          pageId: item.pageId,
          ...acceptedText(item),
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

/** How much of an answer being written is kept to show, the end of it, where the model is now. */
const WRITING_TAIL = 1500;
const VERDICT = { applies: 'Still applies', done: 'Already done', 'not-relevant': 'No longer relevant' } as const;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Records a step of a page's edit, with when it began. */
function step(item: BranchItem, text: string): void {
  item.steps = [...(item.steps ?? []), { at: new Date().toISOString(), text }];
}

/**
 * The page as the model is given it, its edit form without frontmatter so the app's record of the
 * page is never offered as text to keep, and what its markers stand for.
 */
function editOf(page: PageDetail): Pick<BranchItem, 'original' | 'parts' | 'drops'> {
  const form = toEditForm(page.storageXml);
  return { original: `${form.markdown}\n`, ...partsOf(form) };
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
