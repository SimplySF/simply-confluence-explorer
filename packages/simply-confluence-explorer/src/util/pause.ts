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

/**
 * Lets other requests run before going on, so long work on a large space never holds the server for
 * long at a stretch (ADR-054).
 */
export const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** How many items a chunk holds: small enough that one chunk of a large space takes a few milliseconds. */
const CHUNK = 100;

/**
 * Maps a list in chunks with a pause between them, for work that reads every page of a space, so
 * another request is answered between chunks however large the space is.
 */
export async function mapChunked<T, R>(items: T[], fn: (item: T) => R): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    if (i > 0) await pause(); // eslint-disable-line no-await-in-loop -- the pause between chunks is the point
    for (const item of items.slice(i, i + CHUNK)) out.push(fn(item));
  }
  return out;
}
