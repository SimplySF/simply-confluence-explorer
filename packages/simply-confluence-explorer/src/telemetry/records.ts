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

import type { Attrs, Level, Outcome, ProblemKind, SpanKind } from './tracer.js';

// The shapes of what telemetry writes, kept apart from the code that writes them so the browser can
// read them without Node's modules (design doc 0008).

export type SpanRecord = {
  type: 'span';
  at: string;
  traceId: string;
  spanId: string;
  parentId?: string;
  kind: SpanKind;
  name: string;
  durationMs: number;
  outcome: Outcome;
  attrs: Attrs;
  error?: string;
};
export type LogRecord = {
  type: 'log';
  at: string;
  level: Level;
  kind: SpanKind;
  message: string;
  traceId?: string;
  spanId?: string;
  attrs?: Attrs;
};
export type MetricRecord = { type: 'metric'; at: string; values: Record<string, number> };
export type ProblemRecord = { type: 'problem'; at: string; problem: ProblemKind; message: string; traceId?: string };
export type TelemetryRecord = SpanRecord | LogRecord | MetricRecord | ProblemRecord;

/** Work running in the background, as the Observability page lists it. */
export type LiveJob = {
  jobId: string;
  kind: string;
  label: string;
  processed: number;
  total: number;
  startedAt?: string;
  current?: string;
};
