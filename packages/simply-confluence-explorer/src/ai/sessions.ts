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
import type { AiSessionView, SessionFileInfo, SessionScope, SessionTurn } from '../api/types.js';
import { storageToBody } from '../parser/convert.js';
import { within } from '../util/paths.js';
import { readJsonOrEmpty, writePrivateJson } from '../util/privateFile.js';
import type { ChatTurn } from './guard.js';

// Conversations with the AI are kept on the server (ADR-023): one file per conversation in
// data/sessions/, readable only by the user running the server, with the text of its uploaded files
// beside it. A conversation also keeps the outbound guard's placeholder map, which holds the real
// values; it never leaves this machine and is never sent to a browser.

export const FILE_BYTE_LIMIT = 10 * 1024 * 1024;
/** The most text one file may contribute: enough for a long specification, leaving room for pages. */
export const FILE_CHAR_LIMIT = 200_000;
/** How much of the earlier conversation is sent with each new turn; the oldest turns go first. */
export const HISTORY_CHAR_LIMIT = 200_000;

const TEXT_TYPES = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log', '.xml']);
const HTML_TYPES = new Set(['.html', '.htm']);

type Stored = AiSessionView & {
  guardState: Array<[string, string]>;
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
  if (HTML_TYPES.has(ext)) return storageToBody(bytes.toString('utf8'));
  if (TEXT_TYPES.has(ext)) {
    if (bytes.includes(0)) throw new UploadRefused(`${name} looks like a binary file`);
    return bytes.toString('utf8');
  }
  throw new UploadRefused(
    `${ext || 'this file type'} is not supported: use PDF, HTML, Markdown, text, CSV, JSON or YAML`,
  );
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

  public create(scope: SessionScope): AiSessionView {
    const now = new Date().toISOString();
    const s: Stored = {
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

  /** Newest first. A scope given narrows it to conversations about that page or space. */
  public list(scope?: Partial<SessionScope>): AiSessionView[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json') && isSessionId(f.slice(0, -5)))
      .map((f) => this.load(f.slice(0, -5))!)
      .filter(
        (s) =>
          !scope ||
          ((!scope.kind || s.scope.kind === scope.kind) &&
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
  public filesContext(id: string): string {
    const s = this.load(id);
    if (!s) return '';
    return s.files
      .map(
        (f) =>
          `## [File: ${f.name}]${f.truncated ? ' (cut to its first ' + FILE_CHAR_LIMIT + ' characters)' : ''}\n${fs.readFileSync(within(this.filesDir(id), `${f.id}.txt`), 'utf-8')}`,
      )
      .join('\n\n---\n\n');
  }

  public guardState(id: string): Array<[string, string]> {
    return this.load(id)?.guardState ?? [];
  }

  /** Records a question and its answer, and the guard's placeholders after them. */
  public addTurns(id: string, turns: SessionTurn[], guardState: Array<[string, string]>): AiSessionView {
    const s = this.load(id);
    if (!s) throw new Error('no such session');
    s.turns.push(...turns);
    s.guardState = guardState;
    if (s.turns.length === turns.length && turns[0]?.role === 'user') s.title = turns[0].text.slice(0, 80);
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
    return fs.existsSync(f) ? readJsonOrEmpty<Stored>(f) : null;
  }

  private save(s: Stored): void {
    s.updatedAt = new Date().toISOString();
    writePrivateJson(this.file(s.id), s);
  }
}

function viewOf(s: Stored): AiSessionView {
  const { id, scope, title, createdAt, updatedAt, turns, files } = s;
  return { id, scope, title, createdAt, updatedAt, turns, files };
}
