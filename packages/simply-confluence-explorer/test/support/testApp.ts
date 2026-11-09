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

// An app on a temporary data directory, pointed at the fake Confluence, with an AI that records what
// it is sent instead of sending it. The outbound guard runs exactly as it does in production, so a
// test sees what would have left the machine.

import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { GuardedPayload } from '../../src/ai/guard.js';
import { createServer } from '../../src/server.js';
import { FAKE_TOKEN, type FakeConfluence } from './fakeConfluence.js';
import { standInVector } from './standInEmbedder.js';

export type TestApp = {
  base: string;
  dataDir: string;
  /** Every payload the AI was sent, in order. */
  sent: GuardedPayload[];
  /** Every payload sent to be embedded, when the app was started with embeddings. */
  embedded: GuardedPayload[];
  /** Everything that was sent, as one string, for checking what left the machine. */
  sentText: () => string;
  call: <T = Record<string, unknown>>(
    method: string,
    route: string,
    body?: unknown,
  ) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
};

/**
 * The pages of a pack request, each with a line for every section it lists, as a model that follows
 * the prompt replies; a pack entry without them is not kept (ADR-079).
 */
export function packedPages(text: string): Array<{ id: string; sections: string[] }> {
  return [...text.matchAll(/^=== PAGE (\S+): .*===\nSections:\n((?:\d+\. .*\n?)*)/gm)].map((m) => ({
    id: m[1],
    sections: m[2]
      .split('\n')
      .filter(Boolean)
      .map((heading) => `What ${heading.replace(/^\d+\. /, '')} says.`),
  }));
}

/**
 * A metadata reply in the shape the request asked for: one entry for a single page, or an entry for
 * every page of a pack, keyed by the ids the request lists, with a line for each of its sections.
 */
export function metadataReply(payload: GuardedPayload, entry: Record<string, unknown>): string {
  const text = payload.messages.map((m) => m.content).join('\n');
  if (/^=== DIRECTORY \d+: /m.test(text)) return digestReply(text);
  const pages = packedPages(text);
  return JSON.stringify(pages.length ? { pages: pages.map((p) => ({ ...p, ...entry })) } : entry);
}

/**
 * A directory digest reply for every directory a request lists, by its number, with a summary that
 * names the directory, so a test can follow a child's digest into its parent's request (ADR-079).
 */
export function digestReply(text: string): string {
  const directories = [...text.matchAll(/^=== DIRECTORY (\d+): (.*) ===$/gm)].map((m) => ({
    number: Number(m[1]),
    summary: `Digest of ${m[2]}.`,
    kind: 'living',
    topics: ['ops'],
    questions: [`What is in ${m[2]}?`],
  }));
  return JSON.stringify({ directories });
}

/** Replies with the request's placeholders echoed back, so a test can see them restored. */
const echo = (payload: GuardedPayload, n: number): string => {
  const placeholders =
    payload.messages
      .map((m) => m.content)
      .join('\n')
      .match(/\[[A-Z_]+-\d+\]/g) ?? [];
  if (payload.system.includes('return a JSON object')) {
    return metadataReply(payload, {
      summary: 'A page about operations.',
      tags: ['ops'],
      documentType: 'runbook',
      systemsMentioned: ['Postgres'],
    });
  }
  return `answer ${n} ${placeholders.join(' ')}`.trim();
};

export async function startTestApp(
  fake: FakeConfluence,
  reply: (
    payload: GuardedPayload,
    n: number,
    signal?: AbortSignal,
    onText?: (text: string) => void,
  ) => string | Promise<string> = echo,
  env: NodeJS.ProcessEnv = {},
  options: { embeddings?: boolean; contextChars?: number } = {},
): Promise<TestApp> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-app-'));
  fake.writeIgnoreFiles(dataDir);
  const sent: GuardedPayload[] = [];
  const embedded: GuardedPayload[] = [];
  const server: http.Server = createServer({
    webRoot: dataDir,
    dataDir,
    env: {
      CONFLUENCE_URL: fake.url,
      CONFLUENCE_PERSONAL_TOKEN: FAKE_TOKEN,
      ANTHROPIC_API_KEY: 'k',
      AI_PROVIDER: 'anthropic',
      ...env,
    },
    aiTransport: (payload, signal, onText) => {
      sent.push(payload);
      return Promise.resolve(reply(payload, sent.length, signal, onText));
    },
    contextChars: options.contextChars,
    // Records are written at once, so a test can read them back straight after an action.
    telemetryTimers: false,
    indexRetryMs: 0,
    ...(options.embeddings
      ? {
          embedTransport: (payload: GuardedPayload): Promise<number[][]> => {
            embedded.push(payload);
            return Promise.resolve(payload.messages.map((m) => standInVector(m.content)));
          },
        }
      : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return {
    base,
    dataDir,
    sent,
    embedded,
    sentText: () => sent.map((p) => [p.system, ...p.messages.map((m) => m.content)].join('\n')).join('\n'),
    call: async <T>(method: string, route: string, body?: unknown) => {
      const res = await fetch(`${base}${route}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as T };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
