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

// The work a worker thread does (ADR-074): reading files and computing a result, never sending
// anything anywhere. Each task can also run on the main thread, as it does where no pool is given.

import fs from 'node:fs';
import { documentText } from '../spaces/documentText.js';
import { queryLogs, queryTrace, type LogQuery } from '../telemetry/query.js';
import { recordsIn } from '../telemetry/telemetry.js';

export type Task =
  | { kind: 'extract'; file: string; title: string; mediaType: string }
  | { kind: 'logs'; dir: string; query: LogQuery }
  | { kind: 'trace'; dir: string; traceId: string };

/** An attachment's text and what it was read as, or why it has none to give. */
export type Extracted = { text: string; as: string } | { why: string };

export async function runTask(task: Task): Promise<unknown> {
  if (task.kind === 'logs') return queryLogs(recordsIn(task.dir, task.query.since), task.query);
  if (task.kind === 'trace') return queryTrace(recordsIn(task.dir), task.traceId);
  return extract(task.file, task.title, task.mediaType);
}

async function extract(file: string, title: string, mediaType: string): Promise<Extracted> {
  const bytes = fs.readFileSync(file);
  if (!title.toLowerCase().endsWith('.pdf')) return documentText(title, mediaType, bytes);
  const { extractText, getDocumentProxy } = await import('unpdf');
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
  return { as: 'PDF', text: text.trim() || '(This PDF has no text; it may be a scan.)' };
}
