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

// The app's own traces, logs and health numbers (ADR-054, design doc 0008).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSessionView, MetadataProgress } from '../src/api/types.js';
import { patternOf, queryLogs } from '../src/telemetry/query.js';
import { Telemetry, type SpanRecord, type TelemetryRecord } from '../src/telemetry/telemetry.js';
import { expectations } from '../../../test-env/fixtures/dataset.mjs';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp } from './support/testApp.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-tel-'));
const telemetry = (dataDir = tmp()): Telemetry => new Telemetry({ dataDir, timers: false });
const spans = (t: Telemetry): SpanRecord[] => [...t.records()].filter((r): r is SpanRecord => r.type === 'span');

describe('a trace', () => {
  it('nests a span under the one it runs in, and starts a new trace when asked', async () => {
    const t = telemetry();
    await t.span('chat', 'question', {}, () => t.span('retrieval', 'context', { corpusPages: 3 }, () => 1));
    await t.span('chat', 'outer', {}, () => t.span('job', 'meta', {}, () => 1, { root: true }));
    const inner = spans(t).find((s) => s.name === 'context')!;
    const outer = spans(t).find((s) => s.name === 'question')!;
    expect(inner.parentId).toBe(outer.spanId);
    expect(inner.traceId).toBe(outer.traceId);
    expect(inner.attrs).toEqual({ corpusPages: 3 });
    const job = spans(t).find((s) => s.name === 'meta')!;
    expect(job.parentId).toBeUndefined();
    expect(job.traceId).not.toBe(spans(t).find((s) => s.name === 'outer')!.traceId);
  });

  it('ends as an error with its message, or as stopped when the person stopped it', async () => {
    const t = telemetry();
    await expect(t.span('ai', 'fails', {}, () => Promise.reject(new Error('quota exceeded')))).rejects.toThrow();
    const stopped = Object.assign(new Error('stopped'), { status: 499 });
    await expect(t.span('ai', 'stopped', {}, () => Promise.reject(stopped))).rejects.toThrow();
    expect(spans(t).map((s) => [s.name, s.outcome, s.error])).toEqual([
      ['stopped', 'stopped', undefined],
      ['fails', 'error', 'quota exceeded'],
    ]);
  });

  it('counts a quick successful read without storing it, so polling does not fill the files', async () => {
    const t = telemetry();
    await t.span('http', 'GET /api/x', { method: 'GET' }, () => 1);
    await t.span('http', 'POST /api/x', { method: 'POST' }, () => 1);
    expect(spans(t).map((s) => s.name)).toEqual(['POST /api/x']);
  });

  it('attaches a log to the span it was written in', async () => {
    const t = telemetry();
    await t.span('index', 'page', {}, () => t.log('warn', 'index', 'Page 4 was not indexed: timeout'));
    const log = [...t.records()].find((r) => r.type === 'log');
    expect(log).toMatchObject({
      level: 'warn',
      message: 'Page 4 was not indexed: timeout',
      traceId: spans(t)[0].traceId,
    });
  });
});

describe('the telemetry files', () => {
  it('keeps 14 days, removes the oldest beyond the size cap, and skips a damaged line', () => {
    const dataDir = tmp();
    const dir = path.join(dataDir, 'telemetry');
    fs.mkdirSync(dir, { recursive: true });
    const day = (offset: number): string => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const line = (at: string): string =>
      `${JSON.stringify({ type: 'log', at, level: 'info', kind: 'server', message: 'm' })}\n`;
    fs.writeFileSync(path.join(dir, `${day(20)}.jsonl`), line(day(20)));
    fs.writeFileSync(path.join(dir, `${day(2)}.jsonl`), line(`${day(2)}T00:00:00.000Z`).repeat(200));
    fs.writeFileSync(path.join(dir, `${day(0)}.jsonl`), `{"type":"log",\n${line(`${day(0)}T00:00:00.000Z`)}`);
    const t = new Telemetry({ dataDir, timers: false, maxBytes: 1000 });
    expect(fs.readdirSync(dir).sort()).toEqual([`${day(0)}.jsonl`]);
    expect([...t.records()]).toHaveLength(1);
  });
});

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(async () => {
  await fake.close();
});

describe('what telemetry records about real work', () => {
  it('links a question to its retrieval and AI request, and never records page text, prompts, answers, secrets or excluded titles', async () => {
    const app = await startTestApp(fake, undefined, {}, { contextChars: 300 });
    try {
      const poll = async (route: string): Promise<void> => {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
          const { body } = await app.call<{ status: string }>('GET', route);
          if (body.status !== 'running' && body.status !== 'pending') return;
          // eslint-disable-next-line no-await-in-loop -- as above
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      for (const key of ['PEOPLE', 'OPS']) {
        // eslint-disable-next-line no-await-in-loop -- one space at a time
        const { body } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey: key });
        // eslint-disable-next-line no-await-in-loop -- as above
        await poll(`/space-cache/sync/status/${body.jobId}`);
      }
      const index = await app.call<MetadataProgress>('POST', '/space-cache/PEOPLE/metadata/generate', {});
      await poll(`/space-cache/metadata/status/${index.body.jobId}`);
      const prompt = 'Which flights can be booked in economy?';
      for (const key of ['PEOPLE', 'OPS']) {
        // eslint-disable-next-line no-await-in-loop -- one chat at a time
        const { body: c } = await app.call<AiSessionView>('POST', '/ai/sessions', {
          scope: { kind: 'space', spaceKey: key },
        });
        // eslint-disable-next-line no-await-in-loop -- as above
        const answered = await app.call<AiSessionView>('POST', `/ai/sessions/${c.id}/messages`, { prompt });
        // eslint-disable-next-line no-await-in-loop -- as above
        await app.call('POST', `/ai/sessions/${c.id}/suggest`, { kind: 'review' });
        if (key === 'PEOPLE') {
          const traceId = answered.body.turns.at(-1)?.traceId;
          expect(traceId).toBeTruthy();
          const trace = readAll(app.dataDir).filter((r) => r.type === 'span' && r.traceId === traceId) as SpanRecord[];
          expect(trace.map((s) => s.kind).sort()).toEqual(expect.arrayContaining(['ai', 'chat', 'http', 'retrieval']));
        }
      }
      const text = fs
        .readdirSync(path.join(app.dataDir, 'telemetry'))
        .map((f) => fs.readFileSync(path.join(app.dataDir, 'telemetry', f), 'utf8'))
        .join('\n');
      const secret = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
      for (const forbidden of [
        prompt,
        'Flights over 6h',
        'fake-range-a',
        secret,
        'answer 1',
        ...expectations.PEOPLE.excluded,
      ])
        expect(text, forbidden).not.toContain(forbidden);
    } finally {
      await app.close();
    }
  });
});

function readAll(dataDir: string): TelemetryRecord[] {
  const dir = path.join(dataDir, 'telemetry');
  return fs
    .readdirSync(dir)
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l) as TelemetryRecord);
}

describe('a frozen server', () => {
  it('is flagged as a problem when nothing could be answered for over a second', async () => {
    const t = new Telemetry({ dataDir: tmp(), sampleMs: 100 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const until = Date.now() + 1200;
      while (Date.now() < until) {
        // Holds the event loop, as converting a large space all at once would.
      }
      // The check that sees the freeze may be the one after next on a busy machine, so it is waited for.
      const flagged = (): boolean => t.now().problems.some((p) => p.problem === 'frozen');
      for (let waited = 0; waited < 3000 && !flagged(); waited += 50)
        // eslint-disable-next-line no-await-in-loop -- polls until the check has run
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(t.now().problems.map((p) => p.problem)).toContain('frozen');
    } finally {
      t.close();
    }
  });
});

describe('the Logs view', () => {
  const log = (at: number, level: string, kind: string, message: string, spaceKey?: string): TelemetryRecord =>
    ({
      type: 'log',
      at: new Date(Date.UTC(2026, 9, 20, 0, 0, at)).toISOString(),
      level,
      kind,
      message,
      ...(spaceKey ? { attrs: { spaceKey } } : {}),
    }) as TelemetryRecord;
  // Newest first, as the files are read.
  const records = [
    log(9, 'warn', 'index', 'Page 9 was not indexed: timeout after 120 s', 'OPS'),
    log(8, 'warn', 'index', 'Page 8 was not indexed: timeout after 120 s', 'OPS'),
    log(7, 'error', 'ai', 'quota exceeded'),
    log(6, 'info', 'sync', 'synced 12 pages', 'PEOPLE'),
    log(5, 'warn', 'index', 'Page 5 was not indexed: timeout after 90 s', 'PEOPLE'),
  ];

  it('counts each facet across the other filters, and groups copies of one message', () => {
    const page = queryLogs(records, { levels: ['warn'] });
    expect(page.events.map((e) => e.message.slice(0, 6))).toEqual(['Page 9', 'Page 8', 'Page 5']);
    expect(page.facets.level).toEqual({ warn: 3, error: 1, info: 1 });
    expect(page.facets.kind).toEqual({ index: 3 });
    expect(page.facets.space).toEqual({ OPS: 2, PEOPLE: 1 });
    expect(page.groups).toEqual([
      expect.objectContaining({ count: 3, kind: 'index', first: records[4].at, last: records[0].at }),
    ]);
  });

  it('pages by time, and filters by text and space', () => {
    const first = queryLogs(records, { limit: 2 });
    expect(first.events).toHaveLength(2);
    const second = queryLogs(records, { limit: 2, before: first.next });
    expect(second.events.map((e) => e.message)).toEqual(['quota exceeded', 'synced 12 pages']);
    expect(queryLogs(records, { text: 'QUOTA' }).events).toHaveLength(1);
    expect(queryLogs(records, { spaceKey: 'PEOPLE' }).events).toHaveLength(2);
  });

  it('lists a failed AI request, but not a failed step that wrote its own warning, so a failure is said once', () => {
    const span = (kind: string): TelemetryRecord =>
      ({
        type: 'span',
        at: '2026-10-20T00:00:10.000Z',
        traceId: 't',
        spanId: kind,
        kind,
        name: kind === 'ai' ? 'complete' : 'page',
        durationMs: 40,
        outcome: 'error',
        attrs: {},
        error: 'rate limited',
      }) as TelemetryRecord;
    const page = queryLogs([span('index'), span('ai')], {});
    expect(page.events.map((e) => e.kind)).toEqual(['ai']);
    expect(page.events[0].message).toBe('complete failed after 40 ms: rate limited');
  });

  it('names a message by its pattern, without numbers or ids', () => {
    expect(patternOf('Page 9 was not indexed: timeout after 120 s')).toBe(
      patternOf('Page 5 was not indexed: timeout after 90 s'),
    );
  });
});

describe('the Observability routes', () => {
  it('show what is happening now, the events, and one trace with its spans', async () => {
    const app = await startTestApp(fake, (payload) => {
      if (payload.system.includes('return a JSON object')) throw new Error('quota exceeded');
      return 'answer';
    });
    try {
      const { body: sync } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey: 'PEOPLE' });
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
        const { body } = await app.call<{ status: string }>('GET', `/space-cache/sync/status/${sync.jobId}`);
        if (body.status !== 'running' && body.status !== 'pending') break;
      }
      const { body: started } = await app.call<MetadataProgress>('POST', '/space-cache/PEOPLE/metadata/generate', {});
      let run = started;
      while (run.status === 'pending' || run.status === 'running') {
        // eslint-disable-next-line no-await-in-loop -- as above
        run = (await app.call<MetadataProgress>('GET', `/space-cache/metadata/status/${started.jobId}`)).body;
      }
      expect(run.failures?.[0].error).toBe('quota exceeded');
      const logs = (
        await app.call<{ facets: { kind: Record<string, number> }; groups: unknown[] }>(
          'GET',
          '/observe/logs?level=warn',
        )
      ).body;
      expect(logs.facets.kind.index).toBe(run.errorCount);
      expect(logs.groups).toHaveLength(1);
      const trace = (await app.call<{ spans: SpanRecord[] }>('GET', `/observe/traces/${run.traceId}`)).body;
      expect(trace.spans[0]).toMatchObject({ kind: 'job', name: 'meta' });
      // Each pack records how many of its pages failed, and together they account for every failure.
      const packs = trace.spans.filter((s) => s.kind === 'index' && s.name === 'pack');
      expect(packs.reduce((n, s) => n + Number(s.attrs.failed), 0)).toBe(run.errorCount);
      const now = (await app.call<{ problems: Array<{ problem: string }>; jobs: unknown[] }>('GET', '/observe/now'))
        .body;
      expect(now.problems.map((p) => p.problem)).toContain('index-failures');
      expect((await app.call('GET', '/observe/traces/not-a-trace')).status).toBe(400);
    } finally {
      await app.close();
    }
  });
});
