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

import type {
  AiSessionView,
  AttachmentChoice,
  AttachmentsReport,
  BatchProgress,
  BranchItem,
  BranchRun,
  ChatQueue,
  PageDetail,
  SessionScope,
  SessionTurn,
  StagedPage,
} from '../api/types.js';
import {
  applyQueueChanges,
  editOfReply,
  QUEUE_SYSTEM,
  queueChangesOf,
  queueContext,
  pickable,
  SUGGESTION_ID,
  suggestionViews,
  toSuggestions,
} from '../ai/chatQueue.js';
import { CHAT_SYSTEM } from '../ai/engine.js';
import { loadGuardRules, OutboundGuard, withWithheld, type ChatTurn } from '../ai/guard.js';
import { ManifestBuilder, summarise } from '../ai/manifest.js';
import { cutOffNote } from '../ai/reply.js';
import { FILE_BYTE_LIMIT, historyToSend } from '../ai/sessions.js';
import { isValidPageId, isValidSpaceKey, PARAMS } from '../http/guards.js';
import { parseFindings, RECORD_NOTE, REVIEW_ASPECTS, reviewPrompt } from '../branches/branchRuns.js';
import { HttpError, type Router } from '../http/router.js';
import { pageText } from '../branches/pageChanges.js';
import { attachmentsFor } from '../spaces/attachments.js';
import { withoutAttachments, type SpaceStore } from '../spaces/spaceStore.js';
import { loadSpaceSettings } from '../spaces/spaceSettings.js';
import { gatePageForAi, type GateDeps } from '../spaces/aiGate.js';
import { collectBranch, leftOutNote, pagesAsContext } from '../spaces/branchContext.js';
import {
  corpusSize,
  readBatch,
  retrieveContext,
  sectionBatches,
  type RetrieverDeps,
  type SectionRef,
} from '../spaces/contextRetriever.js';
import { corpusPages, MAX_CORPUS_IDS } from '../spaces/corpus.js';
import { pause } from '../util/pause.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

const KINDS = new Set(['page', 'branch', 'pages', 'space']);

const CHANGES_PROMPT = `Turn what this conversation has found or agreed into concrete changes to the pages provided.
Reply with JSON only, in this shape:
{"findings":[{"kind":"incorrect","pages":["Exact page title"],"detail":"what is wrong","suggestion":"what to change"}]}
Kinds: "incorrect", "redundant", "stale", "clarity", "depth", "structure", "operations", "placement" (move, split or merge a page) or "gap" (a page that should exist).
Use exact page titles, and name every page a change is about. An empty list is a valid answer.
${RECORD_NOTE}`;

const idOf = (value: unknown): unknown => (typeof value === 'number' ? String(value) : value);

/** What a chat reads, from a request. Chosen pages are checked against the space and its rules separately. */
function scopeFrom(value: unknown): SessionScope {
  const scope = fieldsOf(value);
  const kind = scope.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind) || !isValidSpaceKey(scope.spaceKey)) {
    throw new HttpError(400, 'a scope with a kind (page, branch, pages or space) and a spaceKey is required');
  }
  const spaceKey = scope.spaceKey.toUpperCase();
  const title = typeof scope.title === 'string' ? scope.title.slice(0, 200) : undefined;
  if (kind === 'space') return { kind, spaceKey, title };
  if (kind === 'pages') {
    const ids = (field: unknown): unknown[] => [...new Set((Array.isArray(field) ? field : []).map(idOf))];
    const dirs = ids(scope.dirs);
    const pageIds = ids(scope.pageIds);
    const tags = [
      ...new Set(
        (Array.isArray(scope.tags) ? scope.tags : [])
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim().toLowerCase().slice(0, 100))
          .filter(Boolean),
      ),
    ];
    if (dirs.length + pageIds.length + tags.length === 0)
      throw new HttpError(400, 'chosen pages need at least one directory, tag or page');
    if (dirs.length + pageIds.length > MAX_CORPUS_IDS || tags.length > 200)
      throw new HttpError(400, `chosen pages name at most ${MAX_CORPUS_IDS} pages and 200 tags`);
    if (![...dirs, ...pageIds].every(isValidPageId)) throw new HttpError(400, 'chosen pages are named by page id');
    return {
      kind,
      spaceKey,
      ...(dirs.length ? { dirs: dirs as string[] } : {}),
      ...(pageIds.length ? { pageIds: pageIds as string[] } : {}),
      ...(tags.length ? { tags } : {}),
      title,
    };
  }
  const pageId = idOf(scope.pageId);
  if (!isValidPageId(pageId)) throw new HttpError(400, 'a page or section scope needs a pageId');
  return { kind: kind as SessionScope['kind'], spaceKey, pageId, title };
}

/** What an answer records about how it was made, when there is anything to record. */
function turnDetails(
  ctx: TurnContext,
  cutOff: SessionTurn['cutOff'],
  attachments: AttachmentsReport,
): Partial<SessionTurn> {
  return {
    ...(cutOff ? { cutOff } : {}),
    ...(ctx.considered ? { considered: ctx.considered } : {}),
    ...(ctx.corpus ? { corpus: ctx.corpus } : {}),
    ...(ctx.weak ? { weakMatch: true } : {}),
    ...(attachments.images.found ? { images: attachments.images } : {}),
    ...(attachments.files ? { attachments } : {}),
  };
}

/** The edit a person has open while they ask, named by ids the server reads it by. */
type Focus = { runId: string; pageId: string };

function focusFrom(value: unknown): Focus | undefined {
  if (value === undefined || value === null) return undefined;
  const f = fieldsOf(value);
  const pageId = idOf(f.pageId);
  if (typeof f.runId !== 'string' || !PARAMS.runId.valid(f.runId) || !isValidPageId(pageId))
    throw new HttpError(400, 'an open edit is named by its run id and page id');
  return { runId: f.runId, pageId };
}

/** Suggestion ids from a request: each one 12 hex characters, at most 200 at once. */
function suggestionIdsFrom(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200)
    throw new HttpError(400, 'ids must name 1 to 200 suggestions');
  if (!value.every((id) => typeof id === 'string' && SUGGESTION_ID.test(id)))
    throw new HttpError(400, 'a suggestion is named by its 12-character id');
  return [...new Set(value as string[])];
}

/**
 * Records the earlier turns a conversation sends, and those it leaves out because the history is
 * longer than a request carries, so the answer can say the start of the conversation was not sent.
 */
function recordHistory(manifest: ManifestBuilder, session: AiSessionView, history: ChatTurn[]): void {
  manifest.includeTurns(
    history.length,
    history.reduce((n, t) => n + t.text.length, 0),
  );
  const dropped = session.turns.slice(0, session.turns.length - history.length);
  if (dropped.length)
    manifest.leaveOut(
      'turn',
      `${dropped.length} earlier messages`,
      dropped.reduce((n, t) => n + t.text.length, 0),
      'history-limit',
    );
}

/** The sections the last two answers read, so a follow-up keeps reading them. */
function keptSections(session: AiSessionView): SectionRef[] {
  return session.turns
    .filter((t) => t.role === 'assistant')
    .slice(-2)
    .flatMap((t) =>
      (t.matchedPages ?? []).flatMap((p) =>
        p.sections?.length ? p.sections.map((s) => ({ pageId: p.id, index: s.index })) : [{ pageId: p.id }],
      ),
    );
}

type TurnContext = {
  context: string;
  /** What this turn's context was built to carry, checked by the engine before sending (ADR-054). */
  manifest: ManifestBuilder;
  withheld: string[];
  note: string;
  matchedPages?: SessionTurn['matchedPages'];
  considered?: number;
  corpus?: SessionTurn['corpus'];
  weak?: boolean;
  /** Every page the chat reads from, so a suggestion can name one that was not retrieved this turn. */
  pages: Array<{ id: string; title: string; version: number }>;
  /** The pages whose text this turn read, whose attachments it accounts for (ADR-069). */
  read: PageDetail[];
};

/**
 * Adds the routes for conversations with the AI (ADR-023). Each turn rebuilds its context from the
 * conversation's scope, so exclusion rules changed between turns apply at once, and every part of the
 * turn passes the outbound guard, uploaded files included.
 *
 * @param router The router to add to.
 * @param services What the routes share.
 */
export function addSessionRoutes(router: Router, services: Services): Router {
  const { ai, sessions, store, exclusions, dataDir, index, branches, reviews } = services;
  const deps: GateDeps = { store, exclusions, client: services.client };
  // A chat that reads pages only sees a store whose pages come without their attachments (ADR-069).
  const storeOf = (session: AiSessionView): SpaceStore =>
    session.attachments === 'pages' ? withoutAttachments(store) : store;
  const found = (id: string): AiSessionView => {
    const session = sessions.get(id);
    if (!session) throw new HttpError(404, 'no such conversation');
    return session;
  };

  /** Refuses chosen pages that are in another space or excluded, so a chat never starts on one. */
  const checkedScope = async (scope: SessionScope): Promise<SessionScope> => {
    for (const id of scope.kind === 'pages' ? [...(scope.dirs ?? []), ...(scope.pageIds ?? [])] : []) {
      // eslint-disable-next-line no-await-in-loop -- each page is checked in turn, and the first refusal stops it
      const gate = await gatePageForAi(id, scope.spaceKey, deps);
      if (gate.page && gate.page.spaceKey.toUpperCase() !== scope.spaceKey)
        throw new HttpError(400, `a chosen page is not in ${scope.spaceKey}`);
      if (!gate.allowed) throw new HttpError(403, gate.reason ?? 'A chosen page cannot be sent to an AI.');
    }
    return scope;
  };

  /** A page chat, or a directory chat in a space that is not synced, read from Confluence as before. */
  const unsyncedContext = async (
    scope: SessionScope,
    manifest: ManifestBuilder,
    reader: SpaceStore = store,
  ): Promise<TurnContext> => {
    const gate = await gatePageForAi(scope.pageId!, scope.spaceKey, deps);
    if (!gate.allowed || !gate.page) throw new HttpError(403, gate.reason ?? 'This page cannot be sent to an AI.');
    if (reader === store) {
      // The PDFs of the page, and of a directory's pages on disk, are read before the request (ADR-069).
      const below = scope.kind === 'branch' ? store.descendants(scope.spaceKey, gate.page.id) : [];
      const pages = [gate.page, ...below.flatMap((n) => store.readPage(scope.spaceKey, n.id) ?? [])];
      await store.attachments.prepare(pages.map((page) => ({ spaceKey: scope.spaceKey, page })));
    }
    const root = reader.readableMarkdown(scope.spaceKey, gate.page);
    const ctx: TurnContext = {
      context: manifest.include('page', gate.page.title, `## [Page: ${gate.page.title}]\n${root}`),
      manifest,
      withheld: [],
      note: '',
      matchedPages: [{ id: gate.page.id, title: gate.page.title, score: 1 }],
      pages: [{ id: gate.page.id, title: gate.page.title, version: gate.page.version }],
      read: [gate.page],
    };
    if (scope.kind === 'branch') {
      const branch = await collectBranch(
        scope.pageId!,
        scope.spaceKey,
        { ...deps, store: reader },
        dataDir,
        services.contextChars - root.length,
      );
      const below = pagesAsContext(branch, manifest);
      if (below) ctx.context += `\n\n---\n\n${below}`;
      ctx.withheld = branch.withheld;
      ctx.note = leftOutNote(branch);
      ctx.matchedPages = [
        ...(ctx.matchedPages ?? []),
        ...branch.pages.map((p) => ({ id: p.page.id, title: p.page.title, score: 1 })),
      ];
      ctx.pages = [
        ctx.pages[0],
        ...branch.pages.map((p) => ({ id: p.page.id, title: p.page.title, version: p.page.version })),
      ];
      ctx.read.push(...branch.pages.map((p) => p.page));
    }
    return ctx;
  };

  /** The pages a chat on a synced space reads from, once its search index is ready. */
  const corpusOf = async (session: AiSessionView): Promise<PageDetail[]> => {
    const { scope } = session;
    // A directory chat refuses an excluded directory page outright, as a page chat does.
    if (scope.kind === 'branch') await unsyncedContext({ ...scope, kind: 'page' }, new ManifestBuilder());
    // Waits for the search index without holding up the server, if the space is still being indexed.
    const building = index.building().find((b) => b.spaceKey === scope.spaceKey);
    if (building) step(session.id, `Waiting for the search index (${building.done} of ${building.total} pages)`);
    await index.ready(scope.spaceKey);
    const corpus = await corpusPages(store, exclusions, scope);
    await pause();
    // A chosen page the synced copy does not hold yet is read from Confluence, through the gate.
    for (const id of scope.kind === 'pages' ? (scope.pageIds ?? []) : []) {
      if (corpus.some((p) => p.id === id)) continue;
      // eslint-disable-next-line no-await-in-loop -- pages are read in the order they were chosen
      const gate = await gatePageForAi(id, scope.spaceKey, deps);
      if (gate.allowed && gate.page?.spaceKey.toUpperCase() === scope.spaceKey) corpus.push(gate.page);
    }
    return corpus;
  };

  /**
   * Starts a thorough answer, which reads up to `THOROUGH_SECTIONS` sections over several requests
   * and combines what each found (design doc 0008); `null` when one request reads the chat's pages in
   * full anyway, or the search finds nothing, so the question is answered as usual.
   */
  const thorough = async (session: AiSessionView, question: string): Promise<BatchProgress | null> => {
    const { scope } = session;
    if (scope.kind === 'page' || !store.isSynced(scope.spaceKey)) return null;
    const corpus = await corpusOf(session);
    if (corpusSize(scope.spaceKey, corpus, index) <= services.contextChars) return null;
    const retriever: RetrieverDeps = {
      store: storeOf(session),
      exclusions,
      dataDir,
      index,
      vectors: services.vectors,
      ai,
      attachments: session.attachments !== 'pages',
    };
    const previous = session.turns.filter((t) => t.role === 'user').at(-1)?.text;
    const batches = await sectionBatches(
      scope.spaceKey,
      corpus,
      { question, previous },
      retriever,
      services.contextChars,
    );
    if (batches.batches.length === 0) return null;
    return reviews.startAnswer({
      sessionId: session.id,
      spaceKey: scope.spaceKey,
      question,
      corpusPages: corpus.length,
      batches: batches.batches,
      read: (ids, manifest) => readBatch(scope.spaceKey, corpus, ids, retriever, services.contextChars, manifest),
      files: (manifest) => sessions.filesContext(session.id, manifest),
      weak: batches.weak,
      account: (ids) => {
        const seen = pagesAccount(session)(corpus.filter((p) => ids.includes(p.id)));
        seen.report.read = seen.report.read.map((r) => ({ ...r, as: `${r.as}, searched for the parts that match` }));
        return seen;
      },
      imageChoice: loadSpaceSettings(dataDir, scope.spaceKey).images,
    });
  };

  /**
   * The context of one turn (ADR-051). The chat's corpus is resolved from the synced copy on every
   * turn, so a rule added since applies, and a page added under a chosen directory is read. A corpus
   * that fits is read in full; a larger one is retrieved from for this question.
   */
  const contextFor = async (session: AiSessionView, prompt: string, signal: AbortSignal): Promise<TurnContext> => {
    const { scope } = session;
    const manifest = new ManifestBuilder();
    let ctx: TurnContext;
    if (scope.kind === 'page' || (scope.kind === 'branch' && !store.isSynced(scope.spaceKey))) {
      ctx = await unsyncedContext(scope, manifest, storeOf(session));
    } else {
      const corpus = await corpusOf(session);
      // A PDF is read before the request is built, so its text goes with this question; a whole space's
      // are read as its index is built instead (ADR-069).
      if (session.attachments !== 'pages' && scope.kind !== 'space') {
        step(session.id, 'Reading the PDFs attached to these pages');
        await store.attachments.prepare(corpus.map((page) => ({ spaceKey: scope.spaceKey, page })));
      }
      const previous = session.turns.filter((t) => t.role === 'user').at(-1)?.text;
      const r = await services.telemetry.span('retrieval', 'context', { corpusPages: corpus.length }, async (span) => {
        const retrieved = await retrieveContext(
          scope.spaceKey,
          corpus,
          { question: prompt, previous, keep: keptSections(session) },
          {
            store: storeOf(session),
            exclusions,
            dataDir,
            index,
            vectors: services.vectors,
            ai,
            signal,
            onStep: (text) => step(session.id, text),
            attachments: session.attachments !== 'pages',
          },
          { budget: services.contextChars, outline: scope.kind === 'space', manifest },
        );
        span.set({
          mode: retrieved.corpus.mode,
          considered: retrieved.considered,
          pagesRead: retrieved.selectedPages.length,
          sectionsRead: retrieved.selectedPages.reduce((n, p) => n + (p.sections?.length ?? 0), 0),
          withheld: retrieved.withheld.length,
          overflow: retrieved.overflow.length,
        });
        return retrieved;
      });
      ctx = {
        context: r.contextMarkdown,
        manifest,
        withheld: r.withheld,
        note: leftOutNote(r),
        matchedPages: r.selectedPages,
        considered: r.considered,
        corpus: r.corpus,
        weak: r.weak,
        pages: corpus.map(({ id, title, version }) => ({ id, title, version })),
        read: corpus.filter((p) => r.selectedPages.some((s) => s.id === p.id)),
      };
    }
    const files = sessions.filesContext(session.id, manifest);
    if (files) ctx.context += `\n\n---\n\n# Files added to this conversation\n\n${files}`;
    return ctx;
  };

  /**
   * The pages of a chat that are too many for one request, which a review reads in batches instead
   * (ADR-051); `null` when they fit, or the chat reads one page or a space not synced.
   */
  const tooManyForOne = async (session: AiSessionView): Promise<PageDetail[] | null> => {
    const { scope } = session;
    if (scope.kind === 'page' || !store.isSynced(scope.spaceKey)) return null;
    await index.ready(scope.spaceKey);
    const pages = await corpusPages(store, exclusions, scope);
    return corpusSize(scope.spaceKey, pages, index) > services.contextChars ? pages : null;
  };

  /** A conversation that questions can be asked in; a draft is written through its own routes. */
  const chat = (id: string): AiSessionView => {
    const session = found(id);
    if (session.scope.kind === 'draft') {
      throw new HttpError(400, 'a draft is written through /api/drafts/:sessionId/messages');
    }
    return session;
  };

  /**
   * Asks one question and records it with its answer. With `suggestions`, the answer is read as a
   * list of suggestions and stored with the turn, together with the pages it read by title.
   */
  // The step each conversation's question is on, while it is being answered (design doc 0008).
  const activity = new Map<string, { step: string; since: number }>();
  const step = (sessionId: string, text: string): void => {
    activity.set(sessionId, { step: text, since: activity.get(sessionId)?.since ?? Date.now() });
  };

  /**
   * The edit a person has open, added to the turn's context so the chat can revise it. It must be
   * one of this chat's edits, and its page is checked against the exclusion rules on every turn.
   */
  const withFocus = async (session: AiSessionView, focus: Focus, ctx: TurnContext): Promise<BranchItem> => {
    if (!(session.runIds ?? []).includes(focus.runId)) throw new HttpError(404, "that edit is not one of this chat's");
    const run = branches.get(focus.runId);
    const item = run.items.find((i) => i.pageId === focus.pageId);
    if (item?.proposed === undefined) throw new HttpError(409, 'that edit is not ready to work on yet');
    const gate = await gatePageForAi(item.pageId, run.spaceKey, deps);
    if (!gate.allowed) throw new HttpError(403, gate.reason ?? 'This page cannot be sent to an AI.');
    const fixes = (item.fixes ?? []).map((f) => `- [${f.kind}] ${f.detail}${f.suggestion ? ` → ${f.suggestion}` : ''}`);
    const attached = session.attachments === 'pages' ? '' : store.attachments.of(run.spaceKey, gate.page!).text;
    const text = `## [Edit of: ${item.title}]\n### The page as it is\n${pageText(item)}\n### The edit so far\n${item.proposed}\n### The suggestions it applies\n${fixes.join('\n')}${attached ? `\n### Its attachments, for context only${attached}` : ''}`;
    ctx.context += `\n\n---\n\n${ctx.manifest.include('page', `${item.title} (its edit)`, text)}`;
    return item;
  };

  const answer = async (
    session: AiSessionView,
    prompt: { shown: string; sent: string },
    signal: AbortSignal,
    suggestions = false,
    focus?: Focus,
  ): Promise<AiSessionView> =>
    services.telemetry.span(
      'chat',
      suggestions ? 'suggestions' : 'question',
      { sessionId: session.id, scope: session.scope.kind, spaceKey: session.scope.spaceKey },
      (span) =>
        answerTraced(session, prompt, signal, suggestions, span.traceId, focus).finally(() =>
          activity.delete(session.id),
        ),
    );

  const answerTraced = async (
    session: AiSessionView,
    prompt: { shown: string; sent: string },
    signal: AbortSignal,
    suggestions: boolean,
    traceId: string,
    focus?: Focus,
  ): Promise<AiSessionView> => {
    step(session.id, 'Gathering what this chat reads');
    const ctx = await contextFor(session, prompt.sent, signal);
    const queue = queueContext(session.suggestions ?? []);
    if (queue && !suggestions) ctx.context += `\n\n---\n\n${ctx.manifest.include('notes', 'review queue', queue)}`;
    const item = focus ? await withFocus(session, focus, ctx) : undefined;
    const guard = new OutboundGuard(loadGuardRules(dataDir, session.scope.spaceKey), sessions.guardState(session.id));
    const history = historyToSend(session.turns);
    recordHistory(ctx.manifest, session, history);
    const seen = accountOfTurn(session, ctx, item);
    ctx.manifest.includeImages(seen.images.map((i) => ({ name: i.name, bytes: i.data.length })));
    ctx.manifest.includeAttachments(seen.report);
    const manifest = ctx.manifest.build();
    step(session.id, 'Writing the answer');
    // A question may change the chat's review queue or revise the open edit; a request for
    // suggestions asks for a list instead.
    const reply = await ai.chat(
      {
        context: ctx.context,
        history,
        prompt: prompt.sent,
        manifest,
        ...(suggestions ? {} : { system: `${CHAT_SYSTEM}\n\n${QUEUE_SYSTEM}` }),
        ...(seen.images.length ? { images: seen.images } : {}),
      },
      { spaceKey: session.scope.spaceKey, guard, signal },
    );
    const report = withWithheld(reply.guard, ctx.withheld);
    const findings = suggestions ? parseFindings(reply.text) : null;
    const queueBlock = suggestions ? { text: reply.text } : queueChangesOf(reply.text);
    const revised = item ? editOfReply(queueBlock.text) : { text: queueBlock.text };
    const now = new Date().toISOString();
    const text = findings
      ? findings.length
        ? `${findings.length} suggestion${findings.length === 1 ? '' : 's'} added to the review queue.`
        : 'Nothing to suggest: the review found nothing to change.'
      : revised.text || (revised.edit ? 'Here is a revised edit.' : reply.text);
    return sessions.addTurns(
      session.id,
      [
        { role: 'user', text: prompt.shown, at: now },
        {
          role: 'assistant',
          text,
          at: now,
          guardSummary: report.summary + ctx.note + cutOffNote(reply.cutOff),
          sent: summarise(manifest),
          engine: ai.getEngine(),
          matchedPages: ctx.matchedPages,
          ...turnDetails(ctx, reply.cutOff, seen.report),
          ...(item && revised.edit
            ? { proposedEdit: { runId: focus!.runId, pageId: item.pageId, title: item.title, text: revised.edit } }
            : {}),
          traceId,
        },
      ],
      guard.exportState(),
      (list, turn) => {
        if (findings) {
          const added = toSuggestions(findings, ctx.pages, turn);
          list.push(...added);
          return { added: added.length, updated: 0, removed: 0 };
        }
        return queueBlock.lines ? applyQueueChanges(queueBlock.lines, list, turn, ctx.pages) : undefined;
      },
    );
  };

  /**
   * The account of the attachments on the pages a turn read, and the open edit's page: each one read,
   * sent or named with why, and the images sent only when the space chose to send them (ADR-066,
   * ADR-069). An answer that searched its pages read only the parts of their attachments that matched.
   */
  /** The account of some of a chat's pages' attachments, with the chat's and the space's choices. */
  const pagesAccount =
    (session: AiSessionView) =>
    (pages: PageDetail[]): ReturnType<typeof attachmentsFor> =>
      attachmentsFor(
        (key, page) => store.attachments.of(key, page),
        pages.map((page) => ({ spaceKey: session.scope.spaceKey, page })),
        { chat: session.attachments, images: loadSpaceSettings(dataDir, session.scope.spaceKey).images },
      );

  const accountOfTurn = (
    session: AiSessionView,
    ctx: TurnContext,
    item?: BranchItem,
  ): ReturnType<typeof attachmentsFor> => {
    const { spaceKey } = session.scope;
    const pages = [...ctx.read];
    const edited = item && store.readPage(spaceKey, item.pageId);
    if (edited && !pages.some((p) => p.id === edited.id)) pages.push(edited);
    const account = pagesAccount(session)(pages);
    if (ctx.corpus?.mode === 'retrieved')
      account.report.read = account.report.read.map((r) => ({
        ...r,
        as: `${r.as}, searched for the parts that match`,
      }));
    return account;
  };

  /** A chat's suggestions with their state, and the runs of edits made from them. */
  const queueOf = (session: AiSessionView): ChatQueue => {
    const runs = (session.runIds ?? []).flatMap((id): BranchRun[] => {
      try {
        return [branches.get(id)];
      } catch {
        // A run file removed by hand: the chat's other runs are still listed.
        return [];
      }
    });
    return { suggestions: suggestionViews(session.suggestions ?? [], runs), runs };
  };

  /** The staged pages of every chat in a space, for its push queue. An excluded page is never listed. */
  const stagedIn = async (spaceKey: string): Promise<StagedPage[]> => {
    const staged: StagedPage[] = [];
    for (const session of sessions.list({ spaceKey })) {
      for (const run of queueOf(session).runs) {
        for (const i of run.items.filter((x) => x.staged && x.status !== 'pushed')) {
          // eslint-disable-next-line no-await-in-loop -- each page is checked in turn
          if (!(await gatePageForAi(i.pageId, spaceKey, deps)).allowed) continue;
          staged.push({
            sessionId: session.id,
            chatTitle: session.title,
            ...(session.scope.pageId && ['page', 'branch'].includes(session.scope.kind)
              ? { chatPageId: session.scope.pageId }
              : {}),
            runId: run.id,
            pageId: i.pageId,
            title: i.title,
            accepted: (i.changes ?? []).filter((c) => c.decision === 'accepted').length,
            status: i.status,
            ...(i.message ? { message: i.message } : {}),
          });
        }
      }
    }
    return staged;
  };

  return (
    router
      .add('POST', '/api/ai/sessions', async ({ body }) =>
        sessions.create(await checkedScope(scopeFrom(fieldsOf(body).scope))),
      )
      .add('GET', '/api/ai/sessions', ({ query }) => {
        // `kind` may name several kinds, such as space,pages for Space chat's list.
        const kinds = (query.get('kind') ?? '').split(',').filter((k) => KINDS.has(k)) as Array<SessionScope['kind']>;
        const list = sessions.list(
          { spaceKey: query.get('spaceKey')?.toUpperCase(), pageId: query.get('pageId') ?? undefined },
          kinds.length ? kinds : undefined,
        );
        return { sessions: list.map(({ turns, ...summary }) => ({ ...summary, turnCount: turns.length })) };
      })
      .add('GET', '/api/ai/sessions/:sessionId', ({ params }) => found(params.sessionId))
      // The step a question is on while it is being answered, or none.
      .add('GET', '/api/ai/sessions/:sessionId/activity', ({ params }) => {
        const now = activity.get(found(params.sessionId).id);
        return now ? { step: now.step, ms: Date.now() - now.since } : { step: null };
      })
      .add('DELETE', '/api/ai/sessions/:sessionId', ({ params }) => ({ deleted: sessions.delete(params.sessionId) }))
      // Renames a conversation, or changes a Space chat between the whole space and chosen pages.
      .add('PATCH', '/api/ai/sessions/:sessionId', async ({ params, body }) => {
        const session = found(params.sessionId);
        const fields = fieldsOf(body);
        const patch: { title?: string; scope?: SessionScope; attachments?: AttachmentChoice } = {};
        if (fields.attachments !== undefined) {
          if (fields.attachments !== 'include' && fields.attachments !== 'pages')
            throw new HttpError(400, 'attachments is include or pages');
          patch.attachments = fields.attachments;
        }
        if (fields.title !== undefined) {
          const title = typeof fields.title === 'string' ? fields.title.trim() : '';
          if (!title || title.length > 80) throw new HttpError(400, 'a title is 1 to 80 characters');
          patch.title = title;
        }
        if (fields.scope !== undefined) {
          const next = scopeFrom({ ...fieldsOf(fields.scope), spaceKey: session.scope.spaceKey });
          const switchable = new Set(['space', 'pages']);
          if (!switchable.has(session.scope.kind) || !switchable.has(next.kind))
            throw new HttpError(400, 'only a Space chat changes between the whole space and chosen pages');
          patch.scope = await checkedScope(next);
        }
        return sessions.update(session.id, patch);
      })
      // Files arrive as base64 inside JSON: they are small enough, and it needs no upload library.
      .add('POST', '/api/ai/sessions/:sessionId/files', async ({ params, body }) => {
        found(params.sessionId);
        const name = optionalString(body, 'name');
        const data = optionalString(body, 'data');
        if (!name?.trim() || data === undefined) throw new HttpError(400, 'name and base64 data are required');
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length > FILE_BYTE_LIMIT)
          throw new HttpError(413, `files are limited to ${FILE_BYTE_LIMIT / 1024 / 1024} MB`);
        const file = await sessions.addFile(params.sessionId, name, bytes);
        return { file, session: found(params.sessionId) };
      })
      .add('DELETE', '/api/ai/sessions/:sessionId/files/:fileId', ({ params }) => {
        sessions.removeFile(params.sessionId, params.fileId);
        return found(params.sessionId);
      })
      // With `thorough`, a question about more pages than one request carries is answered in the
      // background over several requests, and the answer is written to the conversation when done.
      .add('POST', '/api/ai/sessions/:sessionId/messages', async ({ params, body, signal }) => {
        const prompt = optionalString(body, 'prompt')?.trim();
        if (!prompt) throw new HttpError(400, 'prompt is required');
        const session = chat(params.sessionId);
        const batch =
          fieldsOf(body).thorough === true
            ? await thorough(session, prompt).finally(() => activity.delete(session.id))
            : null;
        if (batch) return { ...session, batch };
        return answer(session, { shown: prompt, sent: prompt }, signal, false, focusFrom(fieldsOf(body).focus));
      })
      // Asks for suggestions the person can tick and queue: a review of what the chat reads, or the
      // changes the conversation so far has agreed. The answer's suggestions are stored with the turn.
      .add('POST', '/api/ai/sessions/:sessionId/suggest', async ({ params, body, signal }) => {
        const session = chat(params.sessionId);
        const fields = fieldsOf(body);
        const notes = optionalString(body, 'notes')?.trim().slice(0, 2000);
        if (fields.kind !== 'review' && fields.kind !== 'changes')
          throw new HttpError(400, 'kind must be review or changes');
        if (fields.kind === 'changes' && session.turns.length === 0)
          throw new HttpError(400, 'there is no conversation to turn into changes yet');
        const several = session.scope.kind !== 'page';
        const sent = fields.kind === 'changes' ? CHANGES_PROMPT : reviewPrompt(REVIEW_ASPECTS, several ? 2 : 1, notes);
        const large = await tooManyForOne(session);
        let shown =
          fields.kind === 'changes'
            ? 'Turn this conversation into changes'
            : several
              ? `Review ${large ? `these ${large.length}` : 'these'} pages for problems`
              : 'Suggest improvements to this page';
        if (notes && fields.kind === 'review') shown = `${shown}: ${notes}`;
        if (large) {
          if (session.attachments !== 'pages')
            await store.attachments.prepare(large.map((page) => ({ spaceKey: session.scope.spaceKey, page })));
          const batch = reviews.start({
            sessionId: session.id,
            spaceKey: session.scope.spaceKey,
            pages: large,
            shown,
            prompt: sent,
            kind: fields.kind,
            parse: parseFindings,
            account: pagesAccount(session),
            store: storeOf(session),
          });
          return { ...session, batch };
        }
        return answer(session, { shown, sent }, signal, true);
      })
      // A batched review's progress, the one running in a conversation, and stopping it (ADR-051).
      .add('GET', '/api/ai/batches/:jobId', ({ params }) => {
        const job = reviews.get(params.jobId);
        if (!job) throw new HttpError(404, 'no such review');
        return job;
      })
      .add('GET', '/api/ai/sessions/:sessionId/batch', ({ params }) => ({
        batch: reviews.activeFor(found(params.sessionId).id) ?? null,
      }))
      .add('POST', '/api/ai/batches/:jobId/cancel', ({ params }) => ({ cancelled: reviews.cancel(params.jobId) }))
      // A chat's review queue: its suggestions with their state, and the edits made from them (ADR-060).
      .add('GET', '/api/ai/sessions/:sessionId/queue', ({ params }) => queueOf(chat(params.sessionId)))
      // Makes edits from picked suggestions, each page read fresh from Confluence first (ADR-061).
      .add('POST', '/api/ai/sessions/:sessionId/suggestions/recommend', async ({ params, body }) => {
        const session = chat(params.sessionId);
        const ids = suggestionIdsFrom(fieldsOf(body).ids);
        const views = queueOf(session).suggestions;
        const picked = ids.map((id) => views.find((s) => s.id === id && s.state !== 'dismissed'));
        if (picked.some((s) => !s)) throw new HttpError(404, "a picked suggestion is not in this chat's queue");
        const busy = picked.find((s) => s && !pickable(s));
        if (busy)
          throw new HttpError(409, `An edit for "${busy.detail}" is already being written or waits to be decided.`);
        const run = await branches.recommend({
          spaceKey: session.scope.spaceKey,
          rootPageId: session.scope.pageId ?? '',
          rootTitle: session.title,
          fromSessionId: session.id,
          suggestions: picked.filter((s) => s !== undefined),
        });
        sessions.addRun(session.id, run.id);
        return run;
      })
      .add('POST', '/api/ai/sessions/:sessionId/suggestions/dismiss', ({ params, body }) => {
        const session = chat(params.sessionId);
        const ids = suggestionIdsFrom(fieldsOf(body).ids);
        const undo = fieldsOf(body).undo === true;
        sessions.editSuggestions(session.id, (list) => {
          for (const s of list.filter((x) => ids.includes(x.id))) {
            if (undo) delete s.dismissed;
            else s.dismissed = 'you';
          }
        });
        return queueOf(chat(session.id));
      })
      // Puts a suggestion back to one of its earlier wordings; the wording it had is kept too.
      .add('POST', '/api/ai/sessions/:sessionId/suggestions/:suggestionId/revert', ({ params, body }) => {
        const session = chat(params.sessionId);
        const to = fieldsOf(body).to;
        sessions.editSuggestions(session.id, (list) => {
          const s = list.find((x) => x.id === params.suggestionId);
          const earlier = typeof to === 'number' ? s?.history?.[to] : undefined;
          if (!s || !earlier) throw new HttpError(404, 'that suggestion has no such wording');
          s.history = [
            ...(s.history ?? []),
            { detail: s.detail, suggestion: s.suggestion, turn: session.turns.length },
          ];
          s.detail = earlier.detail;
          s.suggestion = earlier.suggestion;
        });
        return queueOf(chat(session.id));
      })
      // Puts an answer's revised edit into that page's working text, where its changes are decided.
      .add('POST', '/api/ai/sessions/:sessionId/turns/:turn/accept-edit', ({ params }) => {
        const session = chat(params.sessionId);
        const turn = session.turns[Number(params.turn)];
        const proposal = turn?.proposedEdit;
        if (!proposal || turn.proposalClosed) throw new HttpError(404, 'that answer has no edit to accept');
        const run = branches.refine(proposal.runId, proposal.pageId, proposal.text);
        return { session: sessions.closeProposal(session.id, Number(params.turn)), run };
      })
      .add('POST', '/api/ai/sessions/:sessionId/turns/:turn/close-proposal', ({ params }) => {
        const session = chat(params.sessionId);
        if (!session.turns[Number(params.turn)]?.proposedEdit) throw new HttpError(404, 'that answer has no edit');
        return sessions.closeProposal(session.id, Number(params.turn));
      })
      // The staged pages of every chat in a space, which its push queue pushes together.
      .add('GET', '/api/space-cache/:spaceKey/staged', async ({ params }) => ({
        staged: await stagedIn(params.spaceKey.toUpperCase()),
      }))
  );
}
