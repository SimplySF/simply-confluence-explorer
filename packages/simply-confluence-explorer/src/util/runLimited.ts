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

export type Task<T> = () => Promise<T>;

/**
 * Runs tasks with at most `limit` of them in flight at once, and returns their results in order.
 * Reading a large page tree one request at a time is slow, and reading it all at once would flood
 * the Confluence server, so tree reads go through this with a small limit.
 *
 * @param tasks The work to run.
 * @param limit How many may run at the same time.
 */
export async function runLimited<T>(tasks: ReadonlyArray<Task<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    if (next >= tasks.length) return;
    const index = next++;
    results[index] = await tasks[index]();
    return worker();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
