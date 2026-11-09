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

// A request whose reply the app reads as data rather than shows to a person (ADR-079). The prompt is
// written for a weaker model: one task, short numbered rules and an example of the exact reply. The
// reply is validated, a reply that fails is asked for once more with the reason, and a reply that
// fails again is reported to the caller and recorded where a person can see it, never dropped quietly.

import { noTracer, type Tracer } from '../telemetry/tracer.js';
import type { AiEngine } from './engine.js';
import type { ImageInput } from './guard.js';
import type { ManifestBuilder } from './manifest.js';

/** What a prompt for a structured reply is made of. */
export type StructuredPrompt = { task: string; rules: string[]; example: string };

export type StructuredRequest<T> = {
  ai: Pick<AiEngine, 'analyzeDocument'>;
  /** What the reply is about, sent as the document: candidates, or pages. */
  input: string;
  prompt: StructuredPrompt;
  /** The value read from the parsed JSON, or why the reply is not what was asked for. */
  validate: (json: unknown) => T | string;
  /** What the request is for, as the request's title, the manifest's line and the log's message. */
  label: string;
  /** The JSON Schema of the reply, for a provider that can be held to one. */
  schema?: Record<string, unknown>;
  /** What the caller does when no usable reply comes, so the manifest can say so. */
  instead?: string;
  spaceKey?: string;
  signal?: AbortSignal;
  images?: ImageInput[];
  manifest?: ManifestBuilder;
  tracer?: Tracer;
};

/** A structured reply that could not be used after one repair; asking the same way again would not help. */
export class UnusableReply extends Error {}

export type StructuredResult<T> = { ok: true; value: T; repaired: boolean } | { ok: false; reason: string };

/** The prompt as a weaker model follows it best: the task, numbered rules, then the reply to copy the shape of. */
export function structuredPrompt({ task, rules, example }: StructuredPrompt): string {
  const all = ['Reply with one JSON object only: no Markdown fence, and no words before or after it.', ...rules];
  return `${task}\n\nRules:\n${all.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nAn example of a reply in exactly this shape:\n${example}`;
}

/**
 * The JSON object in a reply, or why there is none. The parser's own message is not kept, as it
 * quotes the reply, and the reason travels to the log, which never holds an answer (ADR-054).
 */
export function jsonIn(text: string): { json: unknown } | { error: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return { error: 'the reply held no JSON object' };
  try {
    return { json: JSON.parse(text.slice(start, end + 1)) };
  } catch {
    return { error: 'the reply was not valid JSON' };
  }
}

/**
 * Choices made by number, mapped back to what was offered. A number outside 1..N, or chosen twice, is
 * dropped; a list whose every number is outside the range is an error, as the model misread the task.
 *
 * @param raw The reply's list of choices, each `{ "number": n, "why": "..." }`.
 * @param offered What was offered, numbered from 1 in this order.
 * @param limit The most choices kept.
 */
export function chosenByNumber<T>(
  raw: unknown,
  offered: readonly T[],
  limit: number,
): Array<{ item: T; why?: string }> | string {
  if (!Array.isArray(raw)) return 'it held no list of choices';
  const seen = new Set<number>();
  const chosen = raw.flatMap((entry: unknown) => {
    const e = (entry ?? {}) as { number?: unknown; why?: unknown };
    const n = typeof e.number === 'string' ? Number(e.number) : e.number;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > offered.length || seen.has(n)) return [];
    seen.add(n);
    return [{ item: offered[n - 1], ...(typeof e.why === 'string' ? { why: e.why.slice(0, 200) } : {}) }];
  });
  if (raw.length > 0 && chosen.length === 0) return `none of its numbers was between 1 and ${offered.length}`;
  return chosen.slice(0, limit);
}

/**
 * Asks for a structured reply through the engine, so the outbound guard applies as to any request.
 * A reply that cannot be read or fails `validate` is asked for once more, quoting why; a second
 * failure returns `ok: false`, named in the manifest and logged and counted by the tracer.
 */
export async function askStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const { ai, input, label, validate } = request;
  const ctx = {
    spaceKey: request.spaceKey,
    signal: request.signal,
    json: { schema: request.schema },
    ...(request.images?.length ? { images: request.images } : {}),
  };
  const prompt = structuredPrompt(request.prompt);
  const attempt = async (asked: string): Promise<{ value: T } | { error: string }> => {
    const found = jsonIn((await ai.analyzeDocument(input, asked, label, ctx)).text);
    if ('error' in found) return found;
    const value = validate(found.json);
    return typeof value === 'string' ? { error: value } : { value };
  };
  const first = await attempt(prompt);
  if ('value' in first) return { ok: true, value: first.value, repaired: false };
  const repair = `${prompt}\n\nYour last reply could not be used: ${first.error}. Reply again, following every rule, in exactly the shape of the example.`;
  const second = await attempt(repair);
  if ('value' in second) return { ok: true, value: second.value, repaired: true };
  const reason = `the AI's reply was not what was asked for, twice (${second.error})`;
  request.manifest?.fallback(label, request.instead ? `${reason}, so ${request.instead}` : reason);
  const tracer = request.tracer ?? noTracer;
  tracer.count('ai.fallbacks');
  tracer.log('warn', 'ai', `A structured reply could not be used after one repair: ${label}.`, {
    reason: second.error,
    spaceKey: request.spaceKey,
  });
  return { ok: false, reason };
}
