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
 * An answer from a model, and whether the model stopped before finishing it, at its output limit or
 * because the answer was blocked, so an unfinished answer is never shown as complete (ADR-054).
 */
export type Reply = {
  text: string;
  cutOff?: 'length' | 'blocked';
  /** Images the provider could not answer with, so the answer was made without them (ADR-069). */
  imagesDropped?: string[];
};

/** What an answer says when the model stopped before finishing it. */
export function cutOffNote(cutOff?: Reply['cutOff']): string {
  if (cutOff === 'length') return ' The answer was cut short: the model reached the most it can write in one reply.';
  return cutOff === 'blocked' ? ' The model blocked part of this answer.' : '';
}
