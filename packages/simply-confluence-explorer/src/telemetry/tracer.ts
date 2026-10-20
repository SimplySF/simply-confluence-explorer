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

// The interface the rest of the app records traces and logs through (ADR-054). Code is handed a
// Tracer rather than reaching for a shared one, so tests can pass their own, and code that is not
// given one records nothing.

export type SpanKind =
  'http' | 'chat' | 'ai' | 'retrieval' | 'guard' | 'index' | 'sync' | 'push' | 'job' | 'review' | 'server';
export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Outcome = 'ok' | 'error' | 'stopped';
/** Counts, ids, durations, titles of allowed pages and error messages; never page text or credentials. */
export type Attrs = Record<string, string | number | boolean | null | undefined | string[] | number[] | object>;

/** Problems flagged without any setup, shown until someone looks at them. */
export type ProblemKind = 'frozen' | 'context' | 'ai-failures' | 'index-failures';

/** The counters the health numbers are built from. */
export type Metric = 'ai.requests' | 'ai.failures' | 'index.pages' | 'index.failures' | 'http.requests' | 'http.errors';

export type ActiveSpan = {
  traceId: string;
  spanId: string;
  /** Adds attributes, kept when the span ends. */
  set: (attrs: Attrs) => void;
};

export type Tracer = {
  /**
   * Runs `fn` as a span: a child of the current span, or the start of a new trace with `root`. The span
   * ends when `fn` settles, as an error if it throws, and as stopped if it throws after being stopped.
   */
  span: <T>(
    kind: SpanKind,
    name: string,
    attrs: Attrs,
    fn: (span: ActiveSpan) => Promise<T> | T,
    options?: { root?: boolean },
  ) => Promise<T>;
  current: () => ActiveSpan | undefined;
  /** Records an event, attached to the current span when there is one. */
  log: (level: Level, kind: SpanKind, message: string, attrs?: Attrs) => void;
  count: (metric: Metric, n?: number) => void;
  problem: (problem: ProblemKind, message: string) => void;
};

/** A tracer that records nothing, for code and tests that were given none. */
export const noTracer: Tracer = {
  span: async (_kind, _name, _attrs, fn) => fn({ traceId: '', spanId: '', set: () => undefined }),
  current: () => undefined,
  log: () => undefined,
  count: () => undefined,
  problem: () => undefined,
};
