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

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { errorMessage } from '../util/errors.js';
import type { LiveJob, MetricRecord, ProblemRecord, TelemetryRecord } from './records.js';
import type { ActiveSpan, Attrs, Level, Metric, Outcome, ProblemKind, SpanKind, Tracer } from './tracer.js';

// The app's traces, logs and health numbers, kept on this machine (ADR-054, design doc 0008). Records
// are JSON lines in one file per day under `<data dir>/telemetry/`, written in batches so recording
// never waits on the disk, and read newest first by the Observability page.

export type { LiveJob, LogRecord, MetricRecord, ProblemRecord, SpanRecord, TelemetryRecord } from './records.js';

export type TelemetryOptions = {
  dataDir: string;
  /** Where warnings and errors are also printed as one line each, such as the console. */
  console?: (line: string) => void;
  retentionDays?: number;
  maxBytes?: number;
  /** Starts the timers that sample health and flush records; tests that read records at once turn it off. */
  timers?: boolean;
  /** How often event-loop lag is sampled. */
  sampleMs?: number;
};

const DAY = 24 * 60 * 60 * 1000;
const newId = (bytes: number): string => randomBytes(bytes).toString('hex');
const dayOf = (iso: string): string => iso.slice(0, 10);

type Open = ActiveSpan & { parentId?: string; kind: SpanKind; name: string; start: number; attrs: Attrs };

export class Telemetry implements Tracer {
  public readonly dir: string;
  private readonly context = new AsyncLocalStorage<Open>();
  private buffer: string[] = [];
  private readonly counters = new Map<Metric, number>();
  private readonly points: MetricRecord[] = [];
  private readonly problems: ProblemRecord[] = [];
  private readonly inflight = new Map<string, { method: string; path: string; start: number; traceId: string }>();
  private readonly jobSources = new Set<() => LiveJob[]>();
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private lagNow = { p50: 0, max: 0 };
  private lagMinuteMax = 0;
  private lastSample = performance.now();
  private loopUse = performance.eventLoopUtilization();
  // A freeze still going on: its problem is shown at once and written when it ends.
  private freeze: { record: ProblemRecord; times: number; worst: number } | null = null;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly print: (line: string) => void;

  public constructor(private readonly options: TelemetryOptions) {
    this.dir = path.join(options.dataDir, 'telemetry');
    this.print = options.console ?? ((): void => undefined);
    this.prune();
    this.loadRecentPoints();
    if (options.timers !== false) {
      this.lag.enable();
      this.timers.push(setInterval(() => this.flush(), 1000));
      this.timers.push(setInterval(() => this.sampleLag(), options.sampleMs ?? 5000));
      this.timers.push(setInterval(() => this.rollMinute(), 60_000));
      this.timers.push(setInterval(() => this.prune(), DAY));
      for (const t of this.timers) t.unref();
    }
  }

  public span<T>(
    kind: SpanKind,
    name: string,
    attrs: Attrs,
    fn: (span: ActiveSpan) => Promise<T> | T,
    options: { root?: boolean } = {},
  ): Promise<T> {
    const parent = options.root ? undefined : this.context.getStore();
    const span: Open = {
      traceId: parent?.traceId ?? newId(8),
      spanId: newId(4),
      parentId: parent?.spanId,
      kind,
      name,
      start: Date.now(),
      attrs: { ...attrs },
      set: (more) => Object.assign(span.attrs, more),
    };
    return this.context.run(span, async () => {
      try {
        const result = await fn(span);
        this.end(span, 'ok');
        return result;
      } catch (error) {
        const stopped = (error as { status?: number }).status === 499;
        this.end(span, stopped ? 'stopped' : 'error', stopped ? undefined : errorMessage(error));
        throw error;
      }
    });
  }

  public current(): ActiveSpan | undefined {
    return this.context.getStore();
  }

  public log(level: Level, kind: SpanKind, message: string, attrs?: Attrs): void {
    const span = this.context.getStore();
    this.write({
      type: 'log',
      at: new Date().toISOString(),
      level,
      kind,
      message,
      ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
      ...(attrs ? { attrs } : {}),
    });
    if (level === 'warn' || level === 'error') this.print(`${level}: [${kind}] ${message}`);
  }

  public count(metric: Metric, n = 1): void {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + n);
  }

  /** A sink for code that reports problems as plain messages, recorded as errors of one kind. */
  public sink(kind: SpanKind): (message: string) => void {
    return (message) => this.log('error', kind, message);
  }

  /** Raises a problem the Observability page and the header show until it is looked at. */
  public problem(problem: ProblemKind, message: string): void {
    const record: ProblemRecord = {
      type: 'problem',
      at: new Date().toISOString(),
      problem,
      message,
      ...(this.context.getStore() ? { traceId: this.context.getStore()!.traceId } : {}),
    };
    this.problems.push(record);
    this.problems.splice(0, Math.max(0, this.problems.length - 100));
    this.write(record);
    this.print(`problem: ${message}`);
  }

  /** Tracks a request while it is being answered, so the page can show what is in flight. */
  public begin(method: string, requestPath: string, traceId: string): () => void {
    const id = newId(4);
    this.inflight.set(id, { method, path: requestPath, start: Date.now(), traceId });
    return () => this.inflight.delete(id);
  }

  public addJobSource(source: () => LiveJob[]): void {
    this.jobSources.add(source);
  }

  /** What is happening now, and the last day's health numbers. */
  public now(): {
    jobs: LiveJob[];
    inflight: Array<{ method: string; path: string; ms: number; traceId: string }>;
    lagMs: { p50: number; max: number };
    points: MetricRecord[];
    problems: ProblemRecord[];
  } {
    const now = Date.now();
    return {
      jobs: [...this.jobSources].flatMap((source) => source()),
      // Only requests that have waited a while: the page's own quick checks are not worth listing.
      inflight: [...this.inflight.values()].map((r) => ({ ...r, ms: now - r.start })).filter((r) => r.ms >= 1000),
      lagMs: this.lagNow,
      points: this.points.filter((p) => now - Date.parse(p.at) <= DAY),
      problems: this.problems.slice(-20),
    };
  }

  /**
   * Every record, newest first, from the files for the days that might hold them. Each file is read
   * backwards a piece at a time, so a query that stops early, as every view does, reads only the end
   * of a large day instead of holding the server while it reads the whole file.
   */
  public *records(sinceIso?: string): Generator<TelemetryRecord> {
    this.flush();
    yield* recordsIn(this.dir, sinceIso);
  }

  /** The folder the records are written to, with what is buffered written first, for a worker to read. */
  public recordsFolder(): string {
    this.flush();
    return this.dir;
  }

  /** Writes what is buffered, and stops sampling. */
  public close(): void {
    for (const t of this.timers) clearInterval(t);
    this.lag.disable();
    this.thawed();
    this.flush();
  }

  /** Writes what is buffered now, rather than at the next flush. */
  public flush(): void {
    if (this.buffer.length === 0) return;
    const byDay = new Map<string, string[]>();
    for (const line of this.buffer) {
      const day = dayOf((JSON.parse(line) as { at: string }).at);
      byDay.set(day, [...(byDay.get(day) ?? []), line]);
    }
    this.buffer = [];
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      for (const [day, lines] of byDay) fs.appendFileSync(path.join(this.dir, `${day}.jsonl`), `${lines.join('\n')}\n`);
    } catch (error) {
      // Telemetry is a record, not a gate: a full disk must not stop the app.
      this.print(`could not write telemetry: ${errorMessage(error)}`);
    }
  }

  private end(span: Open, outcome: Outcome, error?: string): void {
    const durationMs = Date.now() - span.start;
    // A quick, successful read is counted but not stored, so a page polling for progress does not
    // fill the files with copies of itself.
    if (span.kind === 'http' && outcome === 'ok' && span.attrs.method === 'GET' && durationMs < 1000) return;
    this.write({
      type: 'span',
      at: new Date(span.start).toISOString(),
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parentId ? { parentId: span.parentId } : {}),
      kind: span.kind,
      name: span.name,
      durationMs,
      outcome,
      attrs: span.attrs,
      ...(error ? { error } : {}),
    });
  }

  private write(record: TelemetryRecord): void {
    this.buffer.push(JSON.stringify(record));
    if (this.options.timers === false) this.flush();
  }

  private sampleLag(): void {
    // How late this check itself ran is measured too, so a freeze it waited behind is seen even when
    // Node's delay monitor has not recorded it by the time the check runs.
    const now = performance.now();
    const late = Math.round(now - this.lastSample - (this.options.sampleMs ?? 5000));
    this.lastSample = now;
    this.lagNow = {
      p50: Math.round(this.lag.percentile(50) / 1e6),
      max: Math.max(Math.round(this.lag.max / 1e6), late),
    };
    this.lag.reset();
    const busy = performance.eventLoopUtilization(this.loopUse);
    this.loopUse = performance.eventLoopUtilization();
    this.lagMinuteMax = Math.max(this.lagMinuteMax, this.lagNow.max);
    if (isFreeze(this.lagNow.max, busy.active)) this.froze(this.lagNow.max);
    else this.thawed();
  }

  /** Counts a check that found the server blocked into the freeze it belongs to, shown as one problem. */
  private froze(ms: number): void {
    if (!this.freeze) {
      const record: ProblemRecord = { type: 'problem', at: new Date().toISOString(), problem: 'frozen', message: '' };
      this.problems.push(record);
      this.problems.splice(0, Math.max(0, this.problems.length - 100));
      this.freeze = { record, times: 0, worst: 0 };
    }
    const f = this.freeze;
    f.times++;
    f.worst = Math.max(f.worst, ms);
    const worst = `${(f.worst / 1000).toFixed(1)} s`;
    const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    f.record.message =
      f.times === 1
        ? `The server could not answer anything for ${worst}.`
        : `The server could not answer for up to ${worst}, ${f.times} times between ${clock(f.record.at)} and ${clock(new Date().toISOString())}.`;
  }

  /** Ends a freeze: it is written once, as a whole, when the server answers again. */
  private thawed(): void {
    if (!this.freeze) return;
    this.write(this.freeze.record);
    this.print(`problem: ${this.freeze.record.message}`);
    this.freeze = null;
  }

  private rollMinute(): void {
    const values: Record<string, number> = {
      lagMaxMs: this.lagMinuteMax,
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
    };
    for (const [metric, n] of this.counters) values[metric] = n;
    this.counters.clear();
    this.lagMinuteMax = 0;
    const point: MetricRecord = { type: 'metric', at: new Date().toISOString(), values };
    this.points.push(point);
    this.points.splice(0, Math.max(0, this.points.length - 1440));
    this.write(point);
    // Most AI requests failing over the last five minutes says the provider or its setup is broken.
    const recent = this.points.slice(-5);
    const asked = recent.reduce((n, p) => n + (p.values['ai.requests'] ?? 0), 0);
    const failed = recent.reduce((n, p) => n + (p.values['ai.failures'] ?? 0), 0);
    if (asked >= 4 && failed / asked > 0.5 && (point.values['ai.failures'] ?? 0) > 0)
      this.problem('ai-failures', `${failed} of the last ${asked} AI requests failed.`);
  }

  private files(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  }

  private loadRecentPoints(): void {
    const since = new Date(Date.now() - DAY).toISOString();
    for (const file of this.files().slice(-2)) {
      for (const line of fs.readFileSync(path.join(this.dir, file), 'utf8').split('\n')) {
        if (!line.includes('"type":"metric"')) continue;
        try {
          const point = JSON.parse(line) as MetricRecord;
          if (point.at >= since) this.points.push(point);
        } catch {
          // A damaged line loses one minute of history, nothing more.
        }
      }
    }
  }

  // Old days go first, then the oldest of what remains while the total is over the cap.
  private prune(): void {
    const keep = this.options.retentionDays ?? 14;
    const cutoff = new Date(Date.now() - keep * DAY).toISOString().slice(0, 10);
    const files = this.files();
    for (const old of files.filter((f) => f.slice(0, 10) < cutoff))
      fs.rmSync(path.join(this.dir, old), { force: true });
    const left = files.filter((f) => f.slice(0, 10) >= cutoff);
    const size = (f: string): number => fs.statSync(path.join(this.dir, f)).size;
    let total = left.reduce((n, f) => n + size(f), 0);
    for (const f of left.slice(0, -1)) {
      if (total <= (this.options.maxBytes ?? 200 * 1024 * 1024)) break;
      total -= size(f);
      fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }
}

/** A check this late means the server could not answer; shorter waits are only recorded as a number. */
const FROZEN_MS = 2000;
/** How much of the wait the event loop must have been busy for it to count as blocked. */
const BLOCKED_SHARE = 0.8;

/**
 * Whether a check that ran `lateMs` late found the server frozen: blocked by its own work for most
 * of the wait. A timer that ran late while the loop sat idle, as macOS does to a process in the
 * background or across sleep, is not a freeze (ADR-063).
 *
 * @param lateMs How late the check ran, or the longest delay Node's monitor saw.
 * @param activeMs How long the event loop was busy since the last check.
 */
export function isFreeze(lateMs: number, activeMs: number): boolean {
  return lateMs > FROZEN_MS && activeMs >= lateMs * BLOCKED_SHARE;
}

/** How much of a file is read at a time when it is read from its end. */
const BACKWARDS_CHUNK = 1 << 20;

/**
 * A file's lines from the last to the first, read a piece at a time from its end. Lines are split on
 * the newline byte, which never occurs inside a multi-byte character, so each line decodes whole.
 */
/**
 * The records in a telemetry folder, newest first, back to the day of `sinceIso`. Each day's file is
 * read backwards, so a query that wants recent records stops early.
 */
export function* recordsIn(dir: string, sinceIso?: string): Generator<TelemetryRecord> {
  if (!fs.existsSync(dir)) return;
  const days = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .reverse();
  for (const file of days) {
    if (sinceIso && path.basename(file, '.jsonl') < dayOf(sinceIso)) break;
    for (const line of linesBackwards(path.join(dir, file))) {
      try {
        yield JSON.parse(line) as TelemetryRecord;
      } catch {
        // A line cut short by a crash is skipped; the records around it are still read.
      }
    }
  }
}

export function* linesBackwards(file: string, chunk = BACKWARDS_CHUNK): Generator<string> {
  const fd = fs.openSync(file, 'r');
  try {
    let position = fs.fstatSync(fd).size;
    let rest = Buffer.alloc(0);
    while (position > 0) {
      const size = Math.min(chunk, position);
      position -= size;
      const piece = Buffer.alloc(size);
      fs.readSync(fd, piece, 0, size, position);
      const buffer = Buffer.concat([piece, rest]);
      let end = buffer.length;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i] !== 0x0a) continue;
        if (i + 1 < end) yield buffer.toString('utf8', i + 1, end);
        end = i;
      }
      rest = buffer.subarray(0, end);
    }
    if (rest.length > 0) yield rest.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
