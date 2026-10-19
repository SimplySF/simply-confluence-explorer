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

import type { AiSessionView, SessionScope, SessionTurn } from '../api/types.js';
import { loadGuardRules, OutboundGuard, withWithheld } from '../ai/guard.js';
import { FILE_BYTE_LIMIT, historyToSend } from '../ai/sessions.js';
import { isValidPageId, isValidSpaceKey } from '../http/guards.js';
import { MAX_REVIEW_PAGES } from '../branches/branchRuns.js';
import { HttpError, type Router } from '../http/router.js';
import { parsePage } from '../parser/convert.js';
import { gatePageForAi, type GateDeps } from '../spaces/aiGate.js';
import { collectBranch, CONTEXT_CHAR_LIMIT, contextCollector, leftOutNote } from '../spaces/branchContext.js';
import { retrieveSpaceContext } from '../spaces/contextRetriever.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

const KINDS = new Set(['page', 'branch', 'pages', 'space']);

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
    const raw: unknown[] = Array.isArray(scope.pageIds) ? scope.pageIds : [];
    const pageIds = raw.map(idOf);
    if (pageIds.length === 0 || pageIds.length > MAX_REVIEW_PAGES || !pageIds.every(isValidPageId))
      throw new HttpError(400, `chosen pages are between 1 and ${MAX_REVIEW_PAGES} page ids`);
    const tags = Array.isArray(scope.tags)
      ? scope.tags.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 100))
      : undefined;
    return { kind, spaceKey, pageIds: [...new Set(pageIds)], ...(tags?.length ? { tags } : {}), title };
  }
  const pageId = idOf(scope.pageId);
  if (!isValidPageId(pageId)) throw new HttpError(400, 'a page or section scope needs a pageId');
  return { kind: kind as SessionScope['kind'], spaceKey, pageId, title };
}

type TurnContext = {
  context: string;
  withheld: string[];
  note: string;
  matchedPages?: SessionTurn['matchedPages'];
  considered?: number;
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
  const { ai, sessions, store, exclusions, dataDir, index } = services;
  const deps: GateDeps = { store, exclusions, client: services.client };
  const found = (id: string): AiSessionView => {
    const session = sessions.get(id);
    if (!session) throw new HttpError(404, 'no such conversation');
    return session;
  };

  /** Refuses chosen pages that are in another space or excluded, so a chat never starts on one. */
  const checkedScope = async (scope: SessionScope): Promise<SessionScope> => {
    for (const id of scope.kind === 'pages' ? (scope.pageIds ?? []) : []) {
      // eslint-disable-next-line no-await-in-loop -- each page is checked in turn, and the first refusal stops it
      const gate = await gatePageForAi(id, scope.spaceKey, deps);
      if (gate.page && gate.page.spaceKey.toUpperCase() !== scope.spaceKey)
        throw new HttpError(400, `a chosen page is not in ${scope.spaceKey}`);
      if (!gate.allowed) throw new HttpError(403, gate.reason ?? 'A chosen page cannot be sent to an AI.');
    }
    return scope;
  };

  const contextFor = async (session: AiSessionView, prompt: string, signal: AbortSignal): Promise<TurnContext> => {
    const { scope } = session;
    let ctx: TurnContext;
    if (scope.kind === 'pages') {
      // Each chosen page is read again and checked on every turn (contextCollector applies the rules),
      // so a rule added since it was chosen applies.
      const { consider, result } = contextCollector(scope.spaceKey, deps, dataDir);
      for (const id of scope.pageIds ?? []) {
        // eslint-disable-next-line no-await-in-loop -- pages are read in the order they were chosen
        const gate = await gatePageForAi(id, scope.spaceKey, deps);
        if (gate.page?.spaceKey.toUpperCase() === scope.spaceKey) consider(gate.page);
      }
      ctx = {
        context: result.pages.map((p) => `## [Page: ${p.page.title}]\n${p.markdown}`).join('\n\n---\n\n'),
        withheld: result.withheld,
        note: leftOutNote(result),
        matchedPages: result.pages.map((p) => ({ id: p.page.id, title: p.page.title, score: 1 })),
      };
    } else if (scope.kind === 'space') {
      // The question before this one, and the pages the last two answers used, carry the conversation.
      const earlier = session.turns;
      const previous = earlier.filter((t) => t.role === 'user').at(-1)?.text;
      const keep = earlier
        .filter((t) => t.role === 'assistant')
        .slice(-2)
        .flatMap((t) => (t.matchedPages ?? []).map((p) => p.id));
      const r = await retrieveSpaceContext(
        scope.spaceKey,
        { question: prompt, previous, keep },
        { store, exclusions, dataDir, index, ai, signal },
      );
      ctx = {
        context: r.contextMarkdown,
        withheld: r.withheld,
        note: leftOutNote(r),
        matchedPages: r.selectedPages,
        considered: r.considered,
      };
    } else {
      const gate = await gatePageForAi(scope.pageId!, scope.spaceKey, deps);
      if (!gate.allowed || !gate.page) throw new HttpError(403, gate.reason ?? 'This page cannot be sent to an AI.');
      const root = parsePage(gate.page).markdown;
      ctx = { context: `## [Page: ${gate.page.title}]\n${root}`, withheld: [], note: '' };
      if (scope.kind === 'branch') {
        const branch = await collectBranch(
          scope.pageId!,
          scope.spaceKey,
          deps,
          dataDir,
          CONTEXT_CHAR_LIMIT - root.length,
        );
        ctx.context += branch.pages.map((p) => `\n\n---\n\n## [Page: ${p.page.title}]\n${p.markdown}`).join('');
        ctx.withheld = branch.withheld;
        ctx.note = leftOutNote(branch);
      }
    }
    const files = sessions.filesContext(session.id);
    if (files) ctx.context += `\n\n---\n\n# Files added to this conversation\n\n${files}`;
    return ctx;
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
      .add('POST', '/api/ai/sessions/:sessionId/messages', async ({ params, body, signal }) => {
        const session = found(params.sessionId);
        if (session.scope.kind === 'draft') {
          throw new HttpError(400, 'a draft is written through /api/drafts/:sessionId/messages');
        }
        const prompt = optionalString(body, 'prompt')?.trim();
        if (!prompt) throw new HttpError(400, 'prompt is required');
        const ctx = await contextFor(session, prompt, signal);
        const guard = new OutboundGuard(
          loadGuardRules(dataDir, session.scope.spaceKey),
          sessions.guardState(session.id),
        );
        const answer = await ai.chat(
          { context: ctx.context, history: historyToSend(session.turns), prompt },
          { spaceKey: session.scope.spaceKey, guard, signal },
        );
        const report = withWithheld(answer.guard, ctx.withheld);
        const now = new Date().toISOString();
        return sessions.addTurns(
          session.id,
          [
            { role: 'user', text: prompt, at: now },
            {
              role: 'assistant',
              text: answer.text,
              at: now,
              guardSummary: report.summary + ctx.note,
              engine: ai.getEngine(),
              matchedPages: ctx.matchedPages,
              ...(ctx.considered ? { considered: ctx.considered } : {}),
            },
          ],
          guard.exportState(),
        );
      })
  );
}
