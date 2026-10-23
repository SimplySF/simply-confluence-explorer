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
  AiSessionView,
  AttachmentChoice,
  DraftState,
  QueuedSuggestion,
  SessionFileInfo,
  SessionScope,
  SessionTurn,
} from '../api/types.js';
import { documentText } from '../spaces/documentText.js';
import { within } from '../util/paths.js';
import { readJsonOrEmpty, writePrivateJson } from '../util/privateFile.js';
import { migrateQueue } from './chatQueue.js';
import type { ChatTurn } from './guard.js';
import type { ManifestBuilder } from './manifest.js';

// Conversations with the AI are kept on the server (ADR-023): one file per conversation in
// data/sessions/, readable only by the user running the server, with the text of its uploaded files
// beside it. A conversation also keeps the outbound guard's placeholder map, which holds the real
// values; it never leaves this machine and is never sent to a browser.

export const FILE_BYTE_LIMIT = 10 * 1024 * 1024;
/** The most text one file may contribute: enough for a long specification, leaving room for pages. */
export const FILE_CHAR_LIMIT = 200_000;
/** How much of the earlier conversation is sent with each new turn; the oldest turns go first. */
export const HISTORY_CHAR_LIMIT = 200_000;

type Stored = AiSessionView & {
  guardState: Array<[string, string]>;
  /** The person named the conversation, so its first question no longer names it. */
  named?: boolean;
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isSessionId = (id: unknown): id is string => typeof id === 'string' && ID.test(id);

export class UploadRefused extends Error {
  public readonly status = 415;
}

/** The text of an uploaded file, extracted here. Anything that is not text is refused. */
export async function extractText(name: string, bytes: Buffer): Promise<string> {
  const ext = path.extname(name).toLowerCase();
  if (bytes.length > FILE_BYTE_LIMIT)
    throw new UploadRefused(`${name} is larger than ${FILE_BYTE_LIMIT / 1024 / 1024} MB`);
  if (ext === '.pdf') {
    // Text only, extracted here, so the outbound guard reads exactly what is sent (ADR-023).
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const { text } = await pdfText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
    if (!text.trim()) throw new UploadRefused(`${name} has no extractable text (it may be a scan)`);
    return text;
  }
  // Every other format is read as an attachment of that format is, so the two never differ (ADR-069).
  const read = documentText(name, '', bytes);
  if ('why' in read) throw new UploadRefused(`${name}: ${read.why}`);
  return read.text;
}

/** The earlier turns that fit the history budget, newest kept, starting with a question. */
export function historyToSend(turns: SessionTurn[], budget = HISTORY_CHAR_LIMIT): ChatTurn[] {
  const kept: ChatTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    used += turns[i].text.length;
    if (used > budget) break;
    kept.unshift({ role: turns[i].role, text: turns[i].text });
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

export class SessionStore {
  private readonly dir: string;

  public constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'data', 'sessions');
  }

  public create(scope: SessionScope, draft?: DraftState): AiSessionView {
    const now = new Date().toISOString();
    const s: Stored = {
      ...(draft ? { draft } : {}),
      id: crypto.randomUUID(),
      scope,
      title: scope.title ?? scope.spaceKey,
      createdAt: now,
      updatedAt: now,
      turns: [],
      files: [],
      guardState: [],
    };
    this.save(s);
    return viewOf(s);
  }

  public get(id: string): AiSessionView | null {
    const s = this.load(id);
    return s ? viewOf(s) : null;
  }

  /** Newest first. A scope given narrows it to conversations about that page or space, of any of `kinds`. */
  public list(scope?: Partial<SessionScope>, kinds?: Array<SessionScope['kind']>): AiSessionView[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json') && isSessionId(f.slice(0, -5)))
      .map((f) => this.load(f.slice(0, -5))!)
      .filter(
        (s) =>
          !scope ||
          ((!scope.kind || s.scope.kind === scope.kind) &&
            (!kinds || kinds.includes(s.scope.kind)) &&
            (!scope.spaceKey || s.scope.spaceKey === scope.spaceKey) &&
            (!scope.pageId || s.scope.pageId === scope.pageId)),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => viewOf(s));
  }

  public delete(id: string): boolean {
    const f = this.file(id);
    if (!fs.existsSync(f)) return false;
    fs.rmSync(f);
    fs.rmSync(this.filesDir(id), { recursive: true, force: true });
    return true;
  }

  public async addFile(id: string, name: string, bytes: Buffer): Promise<SessionFileInfo> {
    const s = this.load(id);
    if (!s) throw new Error('no such session');
    const text = await extractText(name, bytes);
    const info: SessionFileInfo = {
      id: crypto.randomUUID(),
      name: path.basename(name),
      chars: Math.min(text.length, FILE_CHAR_LIMIT),
      truncated: text.length > FILE_CHAR_LIMIT,
      addedAt: new Date().toISOString(),
    };
    fs.mkdirSync(this.filesDir(id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(within(this.filesDir(id), `${info.id}.txt`), text.slice(0, FILE_CHAR_LIMIT), { mode: 0o600 });
    s.files.push(info);
    this.save(s);
    return info;
  }

  public removeFile(id: string, fileId: string): boolean {
    const s = this.load(id);
    if (!s || !isSessionId(fileId)) return false;
    const before = s.files.length;
    s.files = s.files.filter((f) => f.id !== fileId);
    fs.rmSync(within(this.filesDir(id), `${fileId}.txt`), { force: true });
    this.save(s);
    return s.files.length < before;
  }

  /** The uploaded files, as context for the next turn. */
  /** The conversation's files as context, each marked in the manifest when one is given (ADR-054). */
  public filesContext(id: string, manifest?: ManifestBuilder): string {
    const s = this.load(id);
    if (!s) return '';
    return s.files
      .map((f) => {
        const text = `## [File: ${f.name}]${f.truncated ? ' (cut to its first ' + FILE_CHAR_LIMIT + ' characters)' : ''}\n${fs.readFileSync(within(this.filesDir(id), `${f.id}.txt`), 'utf-8')}`;
        return manifest ? manifest.include('file', f.name, text, f.truncated) : text;
      })
      .join('\n\n---\n\n');
  }

  /** Changes a draft conversation's page in progress. */
  public updateDraft(id: string, patch: Partial<DraftState>): AiSessionView {
    const s = this.load(id);
    if (!s?.draft) throw new Error('no such draft');
    s.draft = { ...s.draft, ...patch };
    if (patch.title) s.title = patch.title;
    this.save(s);
    return viewOf(s);
  }

  /** Renames a conversation, or changes what it reads, or whether it reads its pages' attachments. */
  public update(
    id: string,
    patch: {
      title?: string;
      scope?: SessionScope;
      attachments?: AttachmentChoice;
      leftOutFiles?: string[];
      attachmentsSeen?: string[];
    },
  ): AiSessionView {
    const s = this.load(id);
    if (!s) throw new Error('no such session');
    if (patch.title !== undefined) {
      s.title = patch.title;
      s.named = true;
    }
    if (patch.scope) s.scope = patch.scope;
    if (patch.attachments) s.attachments = patch.attachments;
    if (patch.leftOutFiles) s.leftOutFiles = patch.leftOutFiles;
    if (patch.attachmentsSeen) s.attachmentsSeen = patch.attachmentsSeen;
    this.save(s);
    return viewOf(s);
  }

  /** Records a run of edits made from the chat's suggestions. */
  public addRun(id: string, runId: string): AiSessionView {
    const s = this.load(id);
    if (!s) throw new Error('no such session');
    s.runIds = [...(s.runIds ?? []), runId];
    this.save(s);
    return viewOf(s);
  }

  /** Changes the chat's review queue: a suggestion dismissed, brought back or reworded. */
  public editSuggestions(id: string, change: (suggestions: QueuedSuggestion[]) => void): AiSessionView {
    const s = this.load(id);
    if (!s) throw new Error('no such session');
    s.suggestions ??= [];
    change(s.suggestions);
    this.save(s);
    return viewOf(s);
  }

  /** Records that the author accepted or dismissed a proposal, so it is not offered again. */
  public closeProposal(id: string, turn: number): AiSessionView {
    const s = this.load(id);
    const t = s?.turns[turn];
    if (!s || !t || (t.proposedDraft === undefined && t.proposedSeries === undefined && !t.proposedEdit))
      throw new Error('no such proposal');
    t.proposalClosed = true;
    this.save(s);
    return viewOf(s);
  }

  public guardState(id: string): Array<[string, string]> {
    return this.load(id)?.guardState ?? [];
  }

  /**
   * Records a question and its answer, and the guard's placeholders after them. `queue` changes the
   * chat's review queue in the same save, given the answer's turn, and returns what it changed.
   */
  public addTurns(
    id: string,
    turns: SessionTurn[],
    guardState: Array<[string, string]>,
    queue?: (suggestions: QueuedSuggestion[], turn: number) => SessionTurn['queued'],
  ): AiSessionView {
    const s = this.load(id);
    if (!s) throw new Error('no such session');
    s.turns.push(...turns);
    if (queue) {
      s.suggestions ??= [];
      const queued = queue(s.suggestions, s.turns.length - 1);
      if (queued && queued.added + queued.updated + queued.removed > 0) s.turns[s.turns.length - 1].queued = queued;
    }
    s.guardState = guardState;
    if (!s.draft && !s.named && s.turns.length === turns.length && turns[0]?.role === 'user')
      s.title = turns[0].text.slice(0, 80);
    this.save(s);
    return viewOf(s);
  }

  private file(id: string): string {
    if (!isSessionId(id)) throw new Error('invalid session id');
    return within(this.dir, `${id}.json`);
  }

  private filesDir(id: string): string {
    return within(this.dir, id);
  }

  private load(id: string): Stored | null {
    const f = this.file(id);
    if (!fs.existsSync(f)) return null;
    const s = readJsonOrEmpty<Stored>(f);
    if (migrateQueue(s)) writePrivateJson(f, s);
    return s;
  }

  private save(s: Stored): void {
    s.updatedAt = new Date().toISOString();
    writePrivateJson(this.file(s.id), s);
  }
}

function viewOf(s: Stored): AiSessionView {
  const { id, scope, title, createdAt, updatedAt, turns, files, draft, suggestions, runIds } = s;
  const { attachments, leftOutFiles, attachmentsSeen } = s;
  return {
    id,
    scope,
    title,
    createdAt,
    updatedAt,
    turns,
    files,
    ...(draft ? { draft } : {}),
    ...(suggestions ? { suggestions } : {}),
    ...(runIds ? { runIds } : {}),
    ...(attachments ? { attachments } : {}),
    ...(leftOutFiles?.length ? { leftOutFiles } : {}),
    ...(attachmentsSeen?.length ? { attachmentsSeen } : {}),
  };
}
