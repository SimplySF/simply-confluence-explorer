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

// A chat's review queue (ADR-060): the suggestions it made, which the chat itself can add to, reword
// and remove, and the state each one has from the edits made from it. The model changes the queue
// only through a delimited block in its answer, which the server reads, so the browser never
// supplies a suggestion.

import crypto from 'node:crypto';
import type {
  BranchFinding,
  BranchItem,
  BranchRun,
  QueuedSuggestion,
  SessionTurn,
  SuggestionView,
} from '../api/types.js';

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
const QUEUE_BLOCK = /<<<SUGGESTIONS>>>([\s\S]*?)(?:<<<END SUGGESTIONS>>>|$)/;
const EDIT_BLOCK = /<<<EDIT>>>\s*\n?([\s\S]*?)\n?\s*(?:<<<END EDIT>>>|$)/;
/** A suggestion's id, as the model and the browser name it. */
export const SUGGESTION_ID = /^[0-9a-f]{12}$/;

type PageRef = { id: string; title: string; version?: number };

/** New suggestions from an answer's findings, each with the version of the pages it names. */
export function toSuggestions(findings: BranchFinding[], pages: PageRef[], fromTurn: number): QueuedSuggestion[] {
  return findings.map((f) => {
    const named = pages.filter((p) => f.pages.includes(p.title));
    return {
      ...f,
      id: crypto.randomBytes(6).toString('hex'),
      pageIds: Object.fromEntries(named.map((p) => [p.title, p.id])),
      seenVersions: Object.fromEntries(named.flatMap((p) => (p.version ? [[p.id, p.version]] : []))),
      fromTurn,
    };
  });
}

type Queue = { turns: SessionTurn[]; suggestions?: QueuedSuggestion[]; runIds?: string[] };

/**
 * Moves the suggestions an older chat kept on its answers into its queue, once, so every chat has
 * one queue. A page's version was not kept then, so its suggestions are checked against the copy
 * on this machine instead.
 *
 * @returns Whether anything moved.
 */
export function migrateQueue(chat: Queue): boolean {
  let moved = false;
  chat.turns.forEach((turn, i) => {
    const old = turn as SessionTurn & {
      findings?: BranchFinding[];
      pageIds?: Record<string, string>;
      runIds?: string[];
    };
    if (old.runIds?.length) chat.runIds = [...(chat.runIds ?? []), ...old.runIds];
    if (!old.findings && !old.runIds) return;
    if (old.findings) {
      const pages = Object.entries(old.pageIds ?? {}).map(([title, id]) => ({ id, title }));
      const added = toSuggestions(old.findings, pages, i);
      chat.suggestions = [...(chat.suggestions ?? []), ...added];
      turn.queued = { added: added.length, updated: 0, removed: 0 };
    }
    delete old.findings;
    delete old.pageIds;
    delete old.runIds;
    moved = true;
  });
  return moved;
}

/** The chat's open suggestions, as the model is shown them, so it can name each by its id. */
export function queueList(suggestions: QueuedSuggestion[]): string {
  return suggestions
    .filter((s) => !s.dismissed)
    .map(
      (s) =>
        `#${s.id} [${s.kind}] ${s.pages.join(', ') || 'no page'}: ${s.detail}${s.suggestion ? ` → ${s.suggestion}` : ''}`,
    )
    .join('\n');
}

/**
 * What a chat's model is told about its review queue and the open edit. It is the same on every turn,
 * so it never stops the conversation's earlier requests from being reused from the provider's cache.
 */
export const QUEUE_SYSTEM = `This chat keeps a review queue of suggestions for the pages it reads; the context lists it when it has any.
When the person asks you to add, reword or remove suggestions, do it, and end your answer with:
<<<SUGGESTIONS>>>
add {"kind":"clarity","pages":["Exact page title"],"detail":"what is wrong","suggestion":"what to change"}
update #<id> {"detail":"the new wording","suggestion":"the new fix"}
remove #<id>
<<<END SUGGESTIONS>>>
Use one line per change, the kinds incorrect, redundant, stale, clarity, depth, structure, operations, placement or gap, and exact page titles. Leave the block out when the queue does not change.
When the context holds an edit the person is working on and they ask you to change it, answer briefly, then give the complete revised text of the page between <<<EDIT>>> and <<<END EDIT>>>. Change only what they ask. Keep every ⟦n name⟧ marker exactly as written, where its part belongs, and keep each ⟦/n⟧ after its opening marker. Never write a marker the page does not have, and never add the page's id, version, author, dates, address or breadcrumbs.`;

/** The chat's review queue as context, so the model can name each suggestion by its id. */
export function queueContext(suggestions: QueuedSuggestion[]): string {
  const list = queueList(suggestions);
  return list ? `# This chat's review queue\n${list}` : '';
}

/** An answer's proposed revision of the open edit, and the answer with the revision taken out. */
export function editOfReply(text: string): { text: string; edit?: string } {
  const match = EDIT_BLOCK.exec(text);
  if (!match) return { text };
  return { text: text.replace(match[0], '').trim(), edit: match[1].trim() };
}

/** The lines of an answer's queue block, and the answer without the block. */
export function queueChangesOf(text: string): { text: string; lines?: string[] } {
  const match = QUEUE_BLOCK.exec(text);
  if (!match) return { text };
  return { text: text.replace(match[0], '').trim(), lines: match[1].split('\n').map((l) => l.trim()) };
}

/**
 * Applies the lines of an answer's queue block to the chat's queue. An unreadable line, an unknown
 * kind or an id the queue does not have is skipped, so a slip changes nothing it did not name.
 *
 * @param lines The block's lines, from `queueChangesOf`.
 * @param suggestions The chat's queue, changed in place.
 * @param turn The answer's turn.
 * @param pages The pages the chat reads, so a new suggestion's pages are found by title.
 */
export function applyQueueChanges(
  lines: string[],
  suggestions: QueuedSuggestion[],
  turn: number,
  pages: PageRef[],
): NonNullable<SessionTurn['queued']> {
  const counts = { added: 0, updated: 0, removed: 0 };
  for (const line of lines) {
    const op = /^(add|update|remove)\s*(?:#([0-9a-f]{12}))?\s*(\{.*\})?$/i.exec(line);
    if (!op) continue;
    const [, verb, id, json] = op;
    const fields = readJson(json);
    const target = suggestions.find((s) => s.id === id && !s.dismissed);
    if (verb.toLowerCase() === 'add' && fields && isFinding(fields)) {
      suggestions.push(...toSuggestions([fields], pages, turn));
      counts.added++;
    } else if (verb.toLowerCase() === 'update' && target && fields && typeof fields.detail === 'string') {
      target.history = [...(target.history ?? []), { detail: target.detail, suggestion: target.suggestion, turn }];
      target.detail = fields.detail;
      target.suggestion = typeof fields.suggestion === 'string' ? fields.suggestion : target.suggestion;
      counts.updated++;
    } else if (verb.toLowerCase() === 'remove' && target) {
      target.dismissed = 'chat';
      counts.removed++;
    }
  }
  return counts;
}

function readJson(json?: string): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    // An unreadable line changes nothing; the rest of the block is still read.
    return undefined;
  }
}

function isFinding(f: Record<string, unknown>): f is BranchFinding & Record<string, unknown> {
  return (
    typeof f.kind === 'string' &&
    KINDS.has(f.kind) &&
    typeof f.detail === 'string' &&
    Array.isArray(f.pages) &&
    f.pages.every((p) => typeof p === 'string')
  );
}

type State = SuggestionView['state'];
/** The state an edit's status gives its suggestion. */
function stateOf(item: BranchItem): State {
  if (['pending', 'checking', 'working'].includes(item.status)) return 'writing';
  if (item.status === 'pushed') return 'pushed';
  if (item.status === 'skipped') return 'skipped';
  if (item.status === 'rejected') return 'rejected';
  if (['failed', 'push-failed', 'check-failed'].includes(item.status)) return 'failed';
  return item.staged ? 'staged' : 'to-decide';
}
// A suggestion on several pages is as far along as its least finished edit.
const PROGRESS: State[] = ['writing', 'to-decide', 'failed', 'staged', 'pushed', 'rejected', 'skipped'];

/**
 * Each suggestion with the state the chat's runs give it: the newest run that carries it decides
 * whether it is being written, waiting to be decided, staged, pushed, failed, already done or no
 * longer relevant.
 */
export function suggestionViews(suggestions: QueuedSuggestion[], runs: BranchRun[]): SuggestionView[] {
  return suggestions.map((s): SuggestionView => {
    if (s.dismissed) return { ...s, state: 'dismissed' };
    for (const run of [...runs].reverse()) {
      const verdict = run.items.flatMap((i) => i.freshness?.verdicts ?? []).find((v) => v.suggestionId === s.id);
      const items = run.items.filter((i) => i.fixes?.some((f) => f.suggestionId === s.id));
      const live = items.filter((i) => stateOf(i) !== 'writing' || run.status === 'running');
      if (live.length === 0) {
        if (verdict && verdict.verdict !== 'applies')
          return { ...s, state: verdict.verdict, why: verdict.why, runId: run.id };
        continue;
      }
      const states = live.map(stateOf);
      const state = PROGRESS.find((p) => states.includes(p)) ?? 'to-decide';
      const fix = live[0].fixes!.find((f) => f.suggestionId === s.id)!;
      const outdated = fix.detail !== s.detail || (fix.suggestion ?? '') !== (s.suggestion ?? '');
      const why = live.find((i) => i.message && ['failed', 'skipped'].includes(stateOf(i)))?.message;
      return {
        ...s,
        state,
        runId: run.id,
        editPageIds: live.map((i) => i.pageId),
        ...(why ? { why } : {}),
        ...(outdated ? { outdated } : {}),
      };
    }
    return { ...s, state: 'open' };
  });
}

/**
 * Whether a suggestion may be picked to make an edit. One whose edit is being written, or waits to
 * be decided or pushed, is not picked again unless the chat has reworded it since.
 */
export function pickable(s: SuggestionView): boolean {
  if (s.state === 'writing' || s.state === 'dismissed') return false;
  return !['to-decide', 'staged'].includes(s.state) || !!s.outdated;
}
