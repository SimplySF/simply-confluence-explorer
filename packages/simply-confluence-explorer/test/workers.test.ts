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

// Work that cannot be cut into small pieces runs on worker threads (ADR-074): the same result as on
// the main thread, a failed thread that fails its task and is replaced, and nothing on a thread that
// could send anything anywhere.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { WorkerPool } from '../src/workers/pool.js';
import { runTask } from '../src/workers/tasks.js';
import { pdfSaying } from './support/pdf.js';
import { workbook } from './support/zipFiles.js';

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cexp-workers-'));
const logged: string[] = [];
const pool = new WorkerPool((m) => logged.push(m), 2);
afterAll(() => pool.close());

describe('a worker thread', () => {
  it('reads a workbook and a PDF as the main thread does', async () => {
    const xlsx = path.join(dir, 'limits.xlsx');
    fs.writeFileSync(
      xlsx,
      await workbook([
        ['region', 'limit'],
        ['eu', '40'],
      ]),
    );
    const pdf = path.join(dir, 'restore.pdf');
    fs.writeFileSync(pdf, pdfSaying('Restore from the nightly backup.'));
    const tasks = [
      [xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      [pdf, 'application/pdf'],
    ].map(([file, type]) => ({ kind: 'extract' as const, file, title: path.basename(file), mediaType: type }));
    const onThreads = await Promise.all(tasks.map((task) => pool.run(task)));
    expect(onThreads).toEqual(await Promise.all(tasks.map((task) => runTask(task))));
    expect(
      await pool.run({ kind: 'extract', file: pdf, title: 'restore.pdf', mediaType: 'application/pdf' }),
    ).toMatchObject({
      as: 'PDF',
      text: expect.stringContaining('nightly backup'),
    });
  });

  it('answers a telemetry query as the main thread does', async () => {
    const telemetry = path.join(dir, 'telemetry');
    fs.mkdirSync(telemetry, { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(
      path.join(telemetry, `${at.slice(0, 10)}.jsonl`),
      `${JSON.stringify({ type: 'log', at, level: 'warn', kind: 'sync', message: 'slow page' })}\n`,
    );
    const task = {
      kind: 'logs' as const,
      dir: telemetry,
      query: { since: new Date(Date.now() - 60_000).toISOString() },
    };
    const page = await pool.run(task);
    expect(page).toEqual(await runTask(task));
    expect(page).toMatchObject({ events: [{ message: 'slow page' }] });
  });

  it('fails its task with the reason when it stops, and the next task gets a new thread', async () => {
    const script = new URL('./support/stoppingWorker.mjs', import.meta.url);
    const stopping = new WorkerPool(
      (m) => logged.push(m),
      1,
      () => ({ url: script, execArgv: [] }),
    );
    try {
      await expect(stopping.run({ kind: 'trace', dir: 'stop', traceId: 'x' })).rejects.toThrow(/stopped.*code 3/);
      await expect(stopping.run({ kind: 'trace', dir: 'answer', traceId: 'x' })).resolves.toEqual({
        answered: 'answer',
      });
      expect(logged.some((m) => m.includes('a worker thread stopped'))).toBe(true);
    } finally {
      await stopping.close();
    }
  });
});

describe('what a worker thread loads', () => {
  // Followed from the thread's entry through every module it imports.
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const reached = (entry: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    const text = fs.readFileSync(path.join(src, entry), 'utf8');
    for (const [, spec] of text.matchAll(/^import (?!type)[^;]*? from '(\.[^']+)'/gm)) {
      const file = path.relative(src, path.resolve(path.dirname(path.join(src, entry)), spec)).replace(/\.js$/, '.ts');
      reached(file, seen);
    }
    for (const [, spec] of text.matchAll(/await import\('(\.[^']+)'\)/g)) {
      reached(
        path.relative(src, path.resolve(path.dirname(path.join(src, entry)), spec)).replace(/\.js$/, '.ts'),
        seen,
      );
    }
    return seen;
  };

  it('never includes code that calls an AI, the outbound guard, Confluence or GitLab', () => {
    const modules = [...reached('workers/worker.ts')].map((m) => m.split(path.sep).join('/'));
    expect(modules).toContain('workers/tasks.ts');
    for (const banned of ['ai/providers.ts', 'ai/guard.ts', 'ai/engine.ts', 'confluence/client.ts', 'gitlab/client.ts'])
      expect(modules, `a worker thread loads ${banned}`).not.toContain(banned);
  });
});
