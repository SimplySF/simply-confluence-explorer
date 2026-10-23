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

// A few worker threads for the work that cannot be cut into small pieces, such as reading a PDF or a
// workbook, or scanning days of telemetry, so the thread that answers requests keeps answering while
// it runs (ADR-074). This is the only module that starts threads. A thread that fails or stops fails
// the task it held, with the reason, and the next task starts a new one.

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { errorMessage } from '../util/errors.js';
import type { Task } from './tasks.js';

type Job = { id: number; task: Task; resolve: (value: unknown) => void; reject: (error: Error) => void };
type Slot = { worker: Worker; job?: Job };

// Run from the TypeScript sources, as the tests are, a thread loads them with Node's own type
// stripping and a hook that finds a `.ts` file where an import names `.js`. Built, it loads the
// compiled file and needs neither.
const RESOLVE_TS =
  "export async function resolve(s, c, next) { try { return await next(s, c); } catch (e) { if (s.endsWith('.js') && e.code === 'ERR_MODULE_NOT_FOUND') return next(s.slice(0, -3) + '.ts', c); throw e; } }";
const FROM_SOURCES = [
  '--experimental-transform-types',
  '--no-warnings',
  '--import',
  `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(RESOLVE_TS)}`)});`)}`,
];

function entry(): { url: URL; execArgv: string[] } {
  const compiled = new URL('./worker.js', import.meta.url);
  return fs.existsSync(fileURLToPath(compiled))
    ? { url: compiled, execArgv: [] }
    : { url: new URL('./worker.ts', import.meta.url), execArgv: FROM_SOURCES };
}

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly size: number;
  private next = 0;
  private closed = false;

  public constructor(
    private readonly log: (message: string) => void,
    size = Math.max(1, Math.min(4, os.availableParallelism() - 1)),
    // The script a thread runs, which a test replaces with one that fails on purpose.
    private readonly script: () => { url: URL; execArgv: string[] } = entry,
  ) {
    this.size = size;
  }

  /** Runs a task on a thread, as soon as one is free. */
  public run<T>(task: Task): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the worker threads have been stopped'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ id: ++this.next, task, resolve: resolve as (value: unknown) => void, reject });
      this.dispatch();
    });
  }

  /** Stops every thread; a task still running fails with the reason. */
  public async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error('the worker threads have been stopped'));
    await Promise.all(this.slots.splice(0).map((slot) => slot.worker.terminate()));
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const slot = this.slots.find((s) => !s.job) ?? (this.slots.length < this.size ? this.start() : undefined);
      if (!slot) return;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.worker.postMessage({ id: job.id, task: job.task });
    }
  }

  private start(): Slot {
    const { url, execArgv } = this.script();
    const worker = new Worker(url, { execArgv });
    // Idle threads do not keep the process running, so the server can still exit.
    worker.unref();
    const slot: Slot = { worker };
    worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const job = slot.job;
      if (job?.id !== message.id) return;
      slot.job = undefined;
      if (message.error === undefined) job.resolve(message.result);
      else job.reject(new Error(message.error));
      this.dispatch();
    });
    const lost = (reason: string): void => {
      const at = this.slots.indexOf(slot);
      if (at < 0) return;
      this.slots.splice(at, 1);
      if (slot.job) slot.job.reject(new Error(`a worker thread stopped: ${reason}`));
      if (!this.closed) this.log(`a worker thread stopped: ${reason}`);
      this.dispatch();
    };
    worker.on('error', (error) => lost(errorMessage(error)));
    worker.on('exit', (code) => lost(`it exited with code ${code}`));
    this.slots.push(slot);
    return slot;
  }
}
