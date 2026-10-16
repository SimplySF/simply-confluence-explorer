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

const FINISHED = new Set(['completed', 'failed', 'cancelled']);

/**
 * Polls a server job until it finishes. The returned function stops it, so a component that started
 * a job stops polling when it goes away.
 *
 * @param fetchStatus Reads the job's progress.
 * @param handlers Called with each progress report, when the job finishes, and if polling fails.
 * @param handlers.onProgress Called with every progress report.
 * @param handlers.onFinished Called once, when the job has finished.
 * @param handlers.onError Called once, if the progress could not be read.
 * @param intervalMs How often to ask.
 */
export function pollJob<P extends { status: string }>(
  fetchStatus: () => Promise<P>,
  handlers: { onProgress: (p: P) => void; onFinished?: (p: P) => void; onError?: (error: unknown) => void },
  intervalMs = 600,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    fetchStatus().then(
      (p) => {
        if (stopped) return;
        handlers.onProgress(p);
        if (FINISHED.has(p.status)) {
          stop();
          handlers.onFinished?.(p);
        }
      },
      (error: unknown) => {
        if (stopped) return;
        stop();
        handlers.onError?.(error);
      },
    );
  }, intervalMs);
  function stop(): void {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}
