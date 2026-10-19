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

import type { AiSessionView, DraftState, RedundancyDecision, SimilarPage } from '../api/types.js';
import type { AiEngine } from '../ai/engine.js';
import { loadGuardRules, OutboundGuard } from '../ai/guard.js';
import { historyToSend, type SessionStore } from '../ai/sessions.js';
import { createPage } from '../confluence/pagePush.js';
import { HttpError } from '../http/router.js';
import { parsePage } from '../parser/convert.js';
import { gatePageForAi, type GateDeps } from '../spaces/aiGate.js';
import { tokens, type SearchIndex } from '../spaces/searchIndex.js';
import { errorMessage } from '../util/errors.js';

// Writing a new page with an AI co-writer (ADR-025). Before drafting, the existing pages are searched
// for the same content, and the author answers: update that page instead, link to it, or continue.
// No page is created until that answer is recorded.

export type DraftDeps = GateDeps & {
  ai: AiEngine;
  index: SearchIndex;
  sessions: SessionStore;
  dataDir: string;
  log: (message: string) => void;
};

const CANDIDATES = 6;
const DECISIONS = new Set<RedundancyDecision>(['update-existing', 'link', 'continue']);
const OVERLAPS = new Set(['high', 'some', 'low']);
const RANK = { high: 3, some: 2, low: 1 } as const;

const OVERLAP_PROMPT = `A person is about to write a new Confluence page, described first below under "Planned page". The existing pages that follow may already cover it.
For each existing page, judge how much it overlaps with the planned page: "high" (it already says most of this), "some" (part of it), or "low".
Reply with JSON only: {"pages":[{"pageId":"123","overlap":"high","why":"one sentence"}]}`;

const DRAFT_BLOCK = /<<<DRAFT>>>\s*([\s\S]*?)\s*<<<END DRAFT>>>/;

const CO_WRITER_SYSTEM =
  'You are co-writing a new Confluence page with a person. The conversation starts with their notes, the current draft, and any related pages or files. ' +
  'Talk with them about what the page needs. When you propose a change to the page, include the complete revised page in Markdown between a line ' +
  '"<<<DRAFT>>>" and a line "<<<END DRAFT>>>"; they will review it as a diff and accept or dismiss it. Propose one coherent change at a time: an outline first, then sections. ' +
  'Use headings, lists, tables and fenced code blocks; do not use images, raw HTML, footnotes or task lists, which Confluence will not accept from Markdown.';

/**
 * Finds the pages most likely to already say what the planned page will: the synced copy's search
 * index first, then Confluence's own search for pages that are not synced. Every candidate is checked
 * against the exclusion rules before it is shown or sent anywhere, and the AI, when one is set up,
 * judges how much each one overlaps.
 *
 * @param spaceKey The space the page will be in.
 * @param title The planned title.
 * @param notes The author's notes on what the page will say.
 * @param deps What the check reads.
 */
export async function checkRedundancy(
  spaceKey: string,
  title: string,
  notes: string,
  deps: DraftDeps,
): Promise<NonNullable<DraftState['redundancy']>> {
  const found = new Map<string, SimilarPage>();
  for (const hit of deps.index.search(spaceKey, `${title} ${title} ${notes}`, CANDIDATES)) {
    found.set(hit.pageId, { ...hit, spaceKey, source: 'synced' });
  }
  const problems: string[] = [];
  try {
    const words = [...new Set(tokens(`${title} ${notes}`))].slice(0, 6);
    for (const hit of await deps.client().searchPages(spaceKey, words, CANDIDATES)) {
      if (!found.has(hit.pageId)) found.set(hit.pageId, { ...hit, spaceKey, score: 0, source: 'confluence' });
    }
  } catch (error) {
    problems.push(
      `Confluence search was unavailable (${errorMessage(error)}), so only the synced pages were searched.`,
    );
  }

  // A live result carries only a title, so it is read and checked like any page before it is shown.
  const gated = await Promise.all(
    [...found.values()].slice(0, CANDIDATES * 2).map(async (page) => {
      const gate = await gatePageForAi(page.pageId, spaceKey, deps);
      return gate.allowed && gate.page
        ? { ...page, markdown: parsePage(gate.page).markdown.slice(0, 1500) }
        : undefined;
    }),
  );
  const candidates = gated.filter((c): c is SimilarPage & { markdown: string } => c !== undefined);

  if (candidates.length > 0 && deps.ai.isAvailable()) {
    const context = `## Planned page: ${title}\n${notes}\n\n${candidates.map((c) => `---\n## Existing page ${c.pageId}: ${c.title}\n${c.markdown}`).join('\n\n')}`;
    try {
      const answer = await deps.ai.analyzeDocument(context, OVERLAP_PROMPT, `Planned page: ${title}`, { spaceKey });
      const judged = (JSON.parse(/\{[\s\S]*\}/.exec(answer.text)?.[0] ?? '{}') as { pages?: unknown }).pages;
      for (const j of Array.isArray(judged)
        ? (judged as Array<{ pageId?: unknown; overlap?: unknown; why?: unknown }>)
        : []) {
        const c = candidates.find((x) => x.pageId === String(j.pageId));
        if (c && typeof j.overlap === 'string' && OVERLAPS.has(j.overlap)) {
          c.overlap = j.overlap as SimilarPage['overlap'];
          c.why = typeof j.why === 'string' ? j.why : undefined;
        }
      }
    } catch (error) {
      problems.push(`The AI could not judge the overlap (${errorMessage(error)}).`);
    }
  } else if (candidates.length > 0) {
    problems.push('No AI is set up, so the overlap was not judged; the pages are ranked by matching words.');
  }

  const similar = candidates
    .map((c): SimilarPage => ({
      pageId: c.pageId,
      title: c.title,
      spaceKey: c.spaceKey,
      score: c.score,
      source: c.source,
      excerpt: c.excerpt,
      overlap: c.overlap,
      why: c.why,
    }))
    .sort((a, b) => RANK[b.overlap ?? 'low'] - RANK[a.overlap ?? 'low'] || b.score - a.score)
    .slice(0, CANDIDATES);
  return { checkedAt: new Date().toISOString(), similar, ...(problems.length > 0 ? { note: problems.join(' ') } : {}) };
}

/** Starts a draft under a parent page, and runs the check for similar pages at once. */
export async function startDraft(
  input: { spaceKey: string; parentId: string; title: string; notes: string },
  deps: DraftDeps,
): Promise<AiSessionView> {
  let parentTitle: string;
  try {
    parentTitle = (await deps.client().getPageDetail(input.parentId)).title;
  } catch (error) {
    throw new HttpError(404, `the parent page could not be found: ${errorMessage(error)}`);
  }
  const title = input.title.trim();
  const draft: DraftState = {
    title,
    parentId: input.parentId,
    parentTitle,
    notes: input.notes,
    markdown: `# ${title}\n\n`,
  };
  const session = deps.sessions.create(
    { kind: 'draft', spaceKey: input.spaceKey, pageId: input.parentId, title },
    draft,
  );
  return deps.sessions.updateDraft(session.id, {
    redundancy: await checkRedundancy(input.spaceKey, title, input.notes, deps),
  });
}

export function draftOf(id: string, deps: DraftDeps): AiSessionView & { draft: DraftState } {
  const session = deps.sessions.get(id);
  if (!session?.draft) throw new HttpError(404, 'no such draft');
  return session as AiSessionView & { draft: DraftState };
}

/** Records the author's answer to the check. Linking must name pages the check found. */
export function decide(id: string, decision: string, linkedPageIds: string[], deps: DraftDeps): AiSessionView {
  const { draft } = draftOf(id, deps);
  if (!DECISIONS.has(decision as RedundancyDecision))
    throw new HttpError(400, 'the answer must be update-existing, link or continue');
  const known = new Set(draft.redundancy?.similar.map((p) => p.pageId));
  if (decision === 'link' && (linkedPageIds.length === 0 || !linkedPageIds.every((p) => known.has(p)))) {
    throw new HttpError(400, 'link to one or more of the pages the check found');
  }
  return deps.sessions.updateDraft(id, {
    redundancy: {
      ...(draft.redundancy ?? { checkedAt: new Date().toISOString(), similar: [] }),
      decision: decision as RedundancyDecision,
      linkedPageIds: decision === 'link' ? linkedPageIds : [],
      decidedAt: new Date().toISOString(),
    },
  });
}

/**
 * One turn with the co-writer. A complete revised draft in the reply is kept on the turn as a
 * proposal, never applied: the draft changes only when the author saves it.
 */
export async function coWrite(
  id: string,
  prompt: string,
  deps: DraftDeps,
  signal?: AbortSignal,
): Promise<AiSessionView> {
  const session = draftOf(id, deps);
  const { draft, scope } = session;
  if (!draft.redundancy?.decision) throw new HttpError(409, 'answer the check for similar pages first');
  const related = await Promise.all(
    (draft.redundancy.linkedPageIds ?? []).map(async (pageId) => {
      const gate = await gatePageForAi(pageId, scope.spaceKey, deps);
      return gate.allowed && gate.page
        ? `\n\n---\n\n## [Related page: ${gate.page.title}]\n${parsePage(gate.page).markdown}`
        : '';
    }),
  );
  const files = deps.sessions.filesContext(id);
  const context =
    `# New page: ${draft.title}\nUnder: ${draft.parentTitle ?? draft.parentId}\n\n## The author's notes\n${draft.notes || '(none)'}\n\n## Current draft\n${draft.markdown}` +
    `${related.join('')}${files ? `\n\n---\n\n# Files\n\n${files}` : ''}`;

  const guard = new OutboundGuard(loadGuardRules(deps.dataDir, scope.spaceKey), deps.sessions.guardState(id));
  const answer = await deps.ai.chat(
    { context, history: historyToSend(session.turns), prompt, system: CO_WRITER_SYSTEM },
    { spaceKey: scope.spaceKey, guard, signal },
  );
  const proposedDraft = DRAFT_BLOCK.exec(answer.text)?.[1];
  // The draft is kept on the turn rather than in its text, so the history does not resend every version.
  const text = proposedDraft
    ? answer.text.replace(DRAFT_BLOCK, '_(Proposed a revised draft: review it below.)_')
    : answer.text;
  const now = new Date().toISOString();
  return deps.sessions.addTurns(
    id,
    [
      { role: 'user', text: prompt, at: now },
      {
        role: 'assistant',
        text,
        at: now,
        guardSummary: answer.guard.summary,
        engine: deps.ai.getEngine(),
        ...(proposedDraft ? { proposedDraft } : {}),
      },
    ],
    guard.exportState(),
  );
}

export function saveDraft(
  id: string,
  patch: { title?: string; markdown?: string; notes?: string },
  deps: DraftDeps,
): AiSessionView {
  const { draft } = draftOf(id, deps);
  if (draft.createdPageId) throw new HttpError(409, 'this page has already been created');
  const next: Partial<DraftState> = {};
  if (patch.title?.trim()) next.title = patch.title.trim();
  if (patch.markdown !== undefined) next.markdown = patch.markdown;
  if (patch.notes !== undefined) next.notes = patch.notes;
  return deps.sessions.updateDraft(id, next);
}

function readyToCreate(draft: DraftState): void {
  if (draft.createdPageId) throw new HttpError(409, 'this page has already been created');
  if (!draft.redundancy?.decision) throw new HttpError(409, 'answer the check for similar pages first');
  if (draft.redundancy.decision === 'update-existing') {
    throw new HttpError(409, 'you chose to update an existing page instead; open that page and use Improve');
  }
  if (!draft.markdown.replace(/^#.*$/m, '').trim()) throw new HttpError(400, 'the draft is empty');
}

/** Dry-runs the create: what Confluence would refuse, without creating anything. */
export async function checkDraft(id: string, deps: DraftDeps): Promise<{ ok: true }> {
  const { draft, scope } = draftOf(id, deps);
  readyToCreate(draft);
  await createPage(deps.client(), deps.store, deps.log, {
    spaceKey: scope.spaceKey,
    title: draft.title,
    parentId: draft.parentId,
    markdown: draft.markdown,
    dryRun: true,
  });
  return { ok: true };
}

/** Creates the page, after the same dry run, and records it on the draft. */
export async function createFromDraft(id: string, deps: DraftDeps): Promise<AiSessionView> {
  await checkDraft(id, deps);
  const { draft, scope } = draftOf(id, deps);
  const created = await createPage(deps.client(), deps.store, deps.log, {
    spaceKey: scope.spaceKey,
    title: draft.title,
    parentId: draft.parentId,
    markdown: draft.markdown,
    dryRun: false,
  });
  if (!created.pageId) throw new HttpError(502, 'Confluence did not report the new page');
  return deps.sessions.updateDraft(id, { createdPageId: created.pageId, createdUrl: created.webUrl });
}
