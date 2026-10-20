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
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(t.now().problems.map((p) => p.problem)).toContain('frozen');
    } finally {
      t.close();
    }
  });
});
