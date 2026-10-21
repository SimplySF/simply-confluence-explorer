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

// A request about a page can finish after the person has opened another one. Its result belongs to
// the page it was asked for, so it is shown only while that page is still the one on screen.

import type { TaggedPages } from '../../../src/api/types.js';

/**
 * Wraps a setter so that it only applies a result while the page it was requested for is current.
 *
 * @param requested The id of the page the request was about.
 * @param current Reads the id of the page on screen now.
 * @param apply Shows the result.
 */
export function forPage<T>(requested: string, current: () => string | undefined, apply: (value: T) => void) {
  return (value: T): void => {
    if (current() === requested) apply(value);
  };
}

/** What a view says while a space's page catalog is first built, before its tags can be listed. */
export function catalogProgress(spaceKey: string, building: { done: number; total: number }): string {
  return `Reading ${spaceKey}'s pages to list their tags: ${building.done.toLocaleString('en')} of ${building.total.toLocaleString('en')}`;
}

/**
 * Reads a space's tags, asking again each second while its catalog is first built, and tells
 * `onBuilding` how far it has got. Returns a function that stops asking.
 */
export function readTags(
  ask: () => Promise<{ tags: TaggedPages[]; building?: { done: number; total: number } }>,
  onTags: (tags: TaggedPages[]) => void,
  onBuilding: (building: { done: number; total: number }) => void,
  onError: (error: unknown) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = (): void => {
    ask().then(
      (r) => {
        if (stopped) return;
        if (!r.building) return onTags(r.tags);
        onBuilding(r.building);
        timer = setTimeout(next, 1000);
      },
      (e: unknown) => !stopped && onError(e),
    );
  };
  next();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
