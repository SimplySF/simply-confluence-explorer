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

import type { LogRecord, ProblemRecord, SpanRecord, TelemetryRecord } from './records.js';

// What the Observability page asks of the telemetry records (design doc 0008): the events worth
// reading, with counts to filter by and repeated messages grouped, and the spans of one trace.

/** An event as the Logs view lists it: a log line, a problem, or a span that failed. */
export type ObservedEvent = {
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  traceId?: string;
  spaceKey?: string;
  attrs?: Record<string, unknown>;
};

export type LogQuery = {
  levels?: string[];
  kinds?: string[];
  spaceKey?: string;
  text?: string;
  since?: string;
  /** Only events before this time, for the next page. */
  before?: string;
  limit?: number;
};

export type LogPage = {
  events: ObservedEvent[];
  facets: { level: Record<string, number>; kind: Record<string, number>; space: Record<string, number> };
  groups: Array<{ message: string; count: number; first: string; last: string; level: string; kind: string }>;
  /** Where the next page starts, when there is one. */
  next?: string;
};

/** How far back one query reads, so a large log answers quickly. */
const SCAN_LIMIT = 50_000;

function eventOf(record: TelemetryRecord): ObservedEvent | null {
  if (record.type === 'log') return fromLog(record);
  if (record.type === 'problem') return fromProblem(record);
  if (record.type === 'span' && record.outcome === 'error' && LISTED_SPANS.has(record.kind)) return fromSpan(record);
  return null;
}

// A failed AI request, request or job is listed in its own right. Other steps that fail write their
// own warning with what failed, so listing their span as well would say the same thing twice.
const LISTED_SPANS = new Set(['ai', 'http', 'job']);

const spaceOf = (attrs?: Record<string, unknown>): string | undefined =>
  typeof attrs?.spaceKey === 'string' ? attrs.spaceKey : undefined;

const fromLog = (r: LogRecord): ObservedEvent => ({
  at: r.at,
  level: r.level,
  kind: r.kind,
  message: r.message,
  traceId: r.traceId,
  spaceKey: spaceOf(r.attrs),
  attrs: r.attrs,
});

const fromProblem = (r: ProblemRecord): ObservedEvent => ({
  at: r.at,
  level: 'error',
  kind: 'problem',
  message: r.message,
  traceId: r.traceId,
  attrs: { problem: r.problem },
});

const fromSpan = (r: SpanRecord): ObservedEvent => ({
  at: r.at,
  level: 'error',
  kind: r.kind,
  message: `${r.name} failed after ${r.durationMs} ms: ${r.error ?? 'no reason given'}`,
  traceId: r.traceId,
  spaceKey: spaceOf(r.attrs),
  attrs: { ...r.attrs, durationMs: r.durationMs },
});

/** A message with its numbers, quoted names and ids taken out, so copies of one problem read as one. */
export function patternOf(message: string): string {
  return message
    .replace(/"[^"]*"|“[^”]*”/g, '"…"')
    .replace(/\b[0-9a-f]{8,}\b/g, '#')
    .replace(/\d+(\.\d+)?/g, '#');
}

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Whether an event passes the filters other than level and kind, which the facets count across. */
function inScope(event: ObservedEvent, query: LogQuery, text: string | undefined): boolean {
  if (query.spaceKey && event.spaceKey !== query.spaceKey) return false;
  return !text || `${event.message} ${event.kind}`.toLowerCase().includes(text);
}

/**
 * Counts an event in the facets and says whether it passes the level and kind filters. Each facet
 * counts what the other filters leave, so its count says what clicking it would show.
 */
function tally(page: LogPage, event: ObservedEvent, query: LogQuery): boolean {
  const passesLevel = !query.levels?.length || query.levels.includes(event.level);
  const passesKind = !query.kinds?.length || query.kinds.includes(event.kind);
  if (passesKind) bump(page.facets.level, event.level);
  if (passesLevel) bump(page.facets.kind, event.kind);
  if (!passesLevel || !passesKind) return false;
  if (event.spaceKey) bump(page.facets.space, event.spaceKey);
  return true;
}

function addToGroups(groups: Map<string, LogPage['groups'][number]>, event: ObservedEvent): void {
  const key = `${event.level}|${event.kind}|${patternOf(event.message)}`;
  const group = groups.get(key);
  // Records arrive newest first, so the latest event is the first seen and the earliest the last.
  if (group) {
    group.count++;
    group.first = event.at;
  } else
    groups.set(key, {
      message: event.message,
      count: 1,
      first: event.at,
      last: event.at,
      level: event.level,
      kind: event.kind,
    });
}

/**
 * The newest events that match, the counts of every level, kind and space among them, and the
 * repeated messages grouped, from records given newest first.
 *
 * @param records The telemetry records, newest first.
 * @param query What to show.
 */
export function queryLogs(records: Iterable<TelemetryRecord>, query: LogQuery): LogPage {
  const limit = Math.min(query.limit ?? 200, 1000);
  const text = query.text?.trim().toLowerCase();
  const page: LogPage = { events: [], facets: { level: {}, kind: {}, space: {} }, groups: [] };
  const groups = new Map<string, LogPage['groups'][number]>();
  let scanned = 0;
  for (const record of records) {
    if (++scanned > SCAN_LIMIT || (query.since && record.at < query.since)) break;
    const event = eventOf(record);
    if (!event || !inScope(event, query, text)) continue;
    if (!tally(page, event, query)) continue;
    addToGroups(groups, event);
    if (query.before && event.at >= query.before) continue;
    if (page.events.length < limit) page.events.push(event);
    else page.next ??= page.events.at(-1)?.at;
  }
  page.groups = [...groups.values()]
    .filter((g) => g.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
  return page;
}

/** One trace: its spans in the order they started, and the events written in it. */
export function queryTrace(
  records: Iterable<TelemetryRecord>,
  traceId: string,
): { spans: SpanRecord[]; events: ObservedEvent[] } {
  const spans: SpanRecord[] = [];
  const events: ObservedEvent[] = [];
  let scanned = 0;
  for (const record of records) {
    if (++scanned > SCAN_LIMIT * 4) break;
    if (!('traceId' in record) || record.traceId !== traceId) continue;
    if (record.type === 'span') spans.push(record);
    else {
      const event = eventOf(record);
      if (event) events.push(event);
    }
  }
  return {
    spans: spans.sort((a, b) => a.at.localeCompare(b.at)),
    events: events.sort((a, b) => a.at.localeCompare(b.at)),
  };
}
