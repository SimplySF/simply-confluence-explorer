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
import { HttpError, type Router } from '../http/router.js';
import { parsePage } from '../parser/convert.js';
import { gatePageForAi, type GateDeps } from '../spaces/aiGate.js';
import { collectBranch, CONTEXT_CHAR_LIMIT, leftOutNote } from '../spaces/branchContext.js';
import { retrieveSpaceContext } from '../spaces/contextRetriever.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

const KINDS = new Set(['page', 'branch', 'space']);

function scopeFrom(body: unknown): SessionScope {
  const scope = fieldsOf(fieldsOf(body).scope);
  const kind = scope.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind) || !isValidSpaceKey(scope.spaceKey)) {
    throw new HttpError(400, 'a scope with a kind (page, branch for a section, or space) and a spaceKey is required');
  }
  const pageId =
    typeof scope.pageId === 'string' || typeof scope.pageId === 'number' ? String(scope.pageId) : undefined;
  if (kind !== 'space' && !isValidPageId(pageId)) throw new HttpError(400, 'a page or section scope needs a pageId');
  return {
    kind: kind as SessionScope['kind'],
    spaceKey: scope.spaceKey.toUpperCase(),
    pageId,
    title: typeof scope.title === 'string' ? scope.title.slice(0, 200) : undefined,
  };
}

type TurnContext = { context: string; withheld: string[]; note: string; matchedPages?: SessionTurn['matchedPages'] };

/**
 * Adds the routes for conversations with the AI (ADR-023). Each turn rebuilds its context from the
 * conversation's scope, so exclusion rules changed between turns apply at once, and every part of the
 * turn passes the outbound guard, uploaded files included.
 *
 * @param router The router to add to.
 * @param services What the routes share.
 */
export function addSessionRoutes(router: Router, services: Services): Router {
  const { ai, sessions, store, exclusions, dataDir } = services;
  const deps: GateDeps = { store, exclusions, client: services.client };
  const found = (id: string): AiSessionView => {
    const session = sessions.get(id);
    if (!session) throw new HttpError(404, 'no such conversation');
    return session;
  };

  const contextFor = async (session: AiSessionView, prompt: string): Promise<TurnContext> => {
    const { scope } = session;
    let ctx: TurnContext;
    if (scope.kind === 'space') {
      const r = retrieveSpaceContext(scope.spaceKey, prompt, { store, exclusions, dataDir });
      ctx = { context: r.contextMarkdown, withheld: r.withheld, note: '', matchedPages: r.selectedPages };
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
      .add('POST', '/api/ai/sessions', ({ body }) => sessions.create(scopeFrom(body)))
      .add('GET', '/api/ai/sessions', ({ query }) => {
        const kind = query.get('kind') ?? undefined;
        const list = sessions.list({
          kind: kind && KINDS.has(kind) ? (kind as SessionScope['kind']) : undefined,
          spaceKey: query.get('spaceKey')?.toUpperCase(),
          pageId: query.get('pageId') ?? undefined,
        });
        return { sessions: list.map(({ turns, ...summary }) => ({ ...summary, turnCount: turns.length })) };
      })
      .add('GET', '/api/ai/sessions/:sessionId', ({ params }) => found(params.sessionId))
      .add('DELETE', '/api/ai/sessions/:sessionId', ({ params }) => ({ deleted: sessions.delete(params.sessionId) }))
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
        const ctx = await contextFor(session, prompt);
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
            },
          ],
          guard.exportState(),
        );
      })
  );
}
