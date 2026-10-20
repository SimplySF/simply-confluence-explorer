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

import type { AiSessionView, BranchFinding, SessionScope, SessionTurn } from '../api/types.js';
import { loadGuardRules, OutboundGuard, withWithheld } from '../ai/guard.js';
import { FILE_BYTE_LIMIT, historyToSend } from '../ai/sessions.js';
import { isValidPageId, isValidSpaceKey } from '../http/guards.js';
import { parseFindings, REVIEW_ASPECTS, reviewPrompt } from '../branches/branchRuns.js';
import { HttpError, type Router } from '../http/router.js';
import { parsePage } from '../parser/convert.js';
import { gatePageForAi, type GateDeps } from '../spaces/aiGate.js';
import { collectBranch, leftOutNote } from '../spaces/branchContext.js';
import { retrieveContext, type SectionRef } from '../spaces/contextRetriever.js';
import { corpusPages, MAX_CORPUS_IDS } from '../spaces/corpus.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

const KINDS = new Set(['page', 'branch', 'pages', 'space']);

const CHANGES_PROMPT = `Turn what this conversation has found or agreed into concrete changes to the pages provided.
Reply with JSON only, in this shape:
{"findings":[{"kind":"incorrect","pages":["Exact page title"],"detail":"what is wrong","suggestion":"what to change"}]}
Kinds: "incorrect", "redundant", "stale", "clarity", "depth", "structure", "operations", "placement" (move, split or merge a page) or "gap" (a page that should exist).
Use exact page titles, and name every page a change is about. An empty list is a valid answer.`;

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

/** The ids of the chat's pages that suggestions name by title, so each can be queued. */
function pageIdsNamed(findings: BranchFinding[], pages: Array<{ id: string; title: string }>): Record<string, string> {
  const named = new Set(findings.flatMap((f) => f.pages));
  return Object.fromEntries(pages.filter((p) => named.has(p.title)).map((p) => [p.title, p.id]));
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
  withheld: string[];
  note: string;
  matchedPages?: SessionTurn['matchedPages'];
  considered?: number;
  corpus?: SessionTurn['corpus'];
  /** Every page the chat reads from, so a suggestion can name one that was not retrieved this turn. */
  pages: Array<{ id: string; title: string }>;
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
  const { ai, sessions, store, exclusions, dataDir, index, branches } = services;
  const deps: GateDeps = { store, exclusions, client: services.client };
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
  const unsyncedContext = async (scope: SessionScope): Promise<TurnContext> => {
    const gate = await gatePageForAi(scope.pageId!, scope.spaceKey, deps);
    if (!gate.allowed || !gate.page) throw new HttpError(403, gate.reason ?? 'This page cannot be sent to an AI.');
    const root = parsePage(gate.page).markdown;
    const ctx: TurnContext = {
      context: `## [Page: ${gate.page.title}]\n${root}`,
      withheld: [],
      note: '',
      matchedPages: [{ id: gate.page.id, title: gate.page.title, score: 1 }],
      pages: [{ id: gate.page.id, title: gate.page.title }],
    };
    if (scope.kind === 'branch') {
      const branch = await collectBranch(
        scope.pageId!,
        scope.spaceKey,
        deps,
        dataDir,
        services.contextChars - root.length,
      );
      ctx.context += branch.pages.map((p) => `\n\n---\n\n## [Page: ${p.page.title}]\n${p.markdown}`).join('');
      ctx.withheld = branch.withheld;
      ctx.note = leftOutNote(branch);
      ctx.matchedPages = [
        ...(ctx.matchedPages ?? []),
        ...branch.pages.map((p) => ({ id: p.page.id, title: p.page.title, score: 1 })),
      ];
      ctx.pages = ctx.matchedPages.map(({ id, title }) => ({ id, title }));
    }
    return ctx;
  };

  /**
   * The context of one turn (ADR-051). The chat's corpus is resolved from the synced copy on every
   * turn, so a rule added since applies, and a page added under a chosen directory is read. A corpus
   * that fits is read in full; a larger one is retrieved from for this question.
   */
  const contextFor = async (session: AiSessionView, prompt: string, signal: AbortSignal): Promise<TurnContext> => {
    const { scope } = session;
    let ctx: TurnContext;
    if (scope.kind === 'page' || (scope.kind === 'branch' && !store.isSynced(scope.spaceKey))) {
      ctx = await unsyncedContext(scope);
    } else {
      // A directory chat refuses an excluded directory page outright, as a page chat does.
      if (scope.kind === 'branch') await unsyncedContext({ ...scope, kind: 'page' });
      const corpus = corpusPages(store, exclusions, scope);
      // A chosen page the synced copy does not hold yet is read from Confluence, through the gate.
      for (const id of scope.kind === 'pages' ? (scope.pageIds ?? []) : []) {
        if (corpus.some((p) => p.id === id)) continue;
        // eslint-disable-next-line no-await-in-loop -- pages are read in the order they were chosen
        const gate = await gatePageForAi(id, scope.spaceKey, deps);
        if (gate.allowed && gate.page?.spaceKey.toUpperCase() === scope.spaceKey) corpus.push(gate.page);
      }
      const previous = session.turns.filter((t) => t.role === 'user').at(-1)?.text;
      const r = await retrieveContext(
        scope.spaceKey,
        corpus,
        { question: prompt, previous, keep: keptSections(session) },
        { store, exclusions, dataDir, index, vectors: services.vectors, ai, signal },
        { budget: services.contextChars, outline: scope.kind === 'space' },
      );
      ctx = {
        context: r.contextMarkdown,
        withheld: r.withheld,
        note: leftOutNote(r),
        matchedPages: r.selectedPages,
        considered: r.considered,
        corpus: r.corpus,
        pages: corpus.map(({ id, title }) => ({ id, title })),
      };
    }
    const files = sessions.filesContext(session.id);
    if (files) ctx.context += `\n\n---\n\n# Files added to this conversation\n\n${files}`;
    return ctx;
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
  const answer = async (
    session: AiSessionView,
    prompt: { shown: string; sent: string },
    signal: AbortSignal,
    suggestions = false,
  ): Promise<AiSessionView> => {
    const ctx = await contextFor(session, prompt.sent, signal);
    const guard = new OutboundGuard(loadGuardRules(dataDir, session.scope.spaceKey), sessions.guardState(session.id));
    const reply = await ai.chat(
      { context: ctx.context, history: historyToSend(session.turns), prompt: prompt.sent },
      { spaceKey: session.scope.spaceKey, guard, signal },
    );
    const report = withWithheld(reply.guard, ctx.withheld);
    const findings = suggestions ? parseFindings(reply.text) : null;
    const now = new Date().toISOString();
    return sessions.addTurns(
      session.id,
      [
        { role: 'user', text: prompt.shown, at: now },
        {
          role: 'assistant',
          text: findings
            ? `${findings.length} suggestion${findings.length === 1 ? '' : 's'}. Tick the ones to queue as edits.`
            : reply.text,
          at: now,
          guardSummary: report.summary + ctx.note,
          engine: ai.getEngine(),
          matchedPages: ctx.matchedPages,
          ...(ctx.considered ? { considered: ctx.considered } : {}),
          ...(ctx.corpus ? { corpus: ctx.corpus } : {}),
          ...(findings ? { findings, pageIds: pageIdsNamed(findings, ctx.pages) } : {}),
        },
      ],
      guard.exportState(),
    );
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
      .add('DELETE', '/api/ai/sessions/:sessionId', ({ params }) => ({ deleted: sessions.delete(params.sessionId) }))
      // Renames a conversation, or changes a Space chat between the whole space and chosen pages.
      .add('PATCH', '/api/ai/sessions/:sessionId', async ({ params, body }) => {
        const session = found(params.sessionId);
        const fields = fieldsOf(body);
        const patch: { title?: string; scope?: SessionScope } = {};
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
      .add('POST', '/api/ai/sessions/:sessionId/messages', ({ params, body, signal }) => {
        const prompt = optionalString(body, 'prompt')?.trim();
        if (!prompt) throw new HttpError(400, 'prompt is required');
        return answer(chat(params.sessionId), { shown: prompt, sent: prompt }, signal);
      })
      // Asks for suggestions the person can tick and queue: a review of what the chat reads, or the
      // changes the conversation so far has agreed. The answer's suggestions are stored with the turn.
      .add('POST', '/api/ai/sessions/:sessionId/suggest', ({ params, body, signal }) => {
        const session = chat(params.sessionId);
        const fields = fieldsOf(body);
        const notes = optionalString(body, 'notes')?.trim().slice(0, 2000);
        if (fields.kind === 'changes') {
          if (session.turns.length === 0) throw new HttpError(400, 'there is no conversation to turn into changes yet');
          return answer(session, { shown: 'Turn this conversation into changes', sent: CHANGES_PROMPT }, signal, true);
        }
        if (fields.kind !== 'review') throw new HttpError(400, 'kind must be review or changes');
        const several = session.scope.kind !== 'page';
        const prompt = reviewPrompt(REVIEW_ASPECTS, several ? 2 : 1, notes);
        const shown = several ? 'Review these pages for problems' : 'Suggest improvements to this page';
        return answer(session, { shown: notes ? `${shown}: ${notes}` : shown, sent: prompt }, signal, true);
      })
      // Stages an edit of each page the chosen suggestions of one answer name (ADR-049).
      .add('POST', '/api/ai/sessions/:sessionId/turns/:turn/queue', async ({ params, body }) => {
        const session = chat(params.sessionId);
        const turnIndex = Number(params.turn);
        const turn = session.turns[turnIndex];
        if (turn?.role !== 'assistant' || !turn.findings) throw new HttpError(404, 'that answer has no suggestions');
        const chosen = fieldsOf(body).findings;
        if (!Array.isArray(chosen) || chosen.some((i) => typeof i !== 'number'))
          throw new HttpError(400, 'findings must be a list of suggestion numbers');
        const run = await branches.stageEdits(
          {
            spaceKey: session.scope.spaceKey,
            rootPageId: session.scope.pageId ?? '',
            rootTitle: session.title,
            findings: turn.findings,
            pageIds: turn.pageIds ?? {},
            fromSessionId: session.id,
          },
          chosen as number[],
        );
        sessions.addRun(session.id, turnIndex, run.id);
        return run;
      })
  );
}
