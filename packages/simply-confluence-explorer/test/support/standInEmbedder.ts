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

// A stand-in for a provider's embeddings. Words that mean the same thing share a dimension, so a test
// can show a question found by its meaning where none of its words appear in the section.

const MEANS: Record<string, string> = {
  down: 'outage',
  outage: 'outage',
  unreachable: 'outage',
  unavailable: 'outage',
  offline: 'outage',
  restore: 'recover',
  recover: 'recover',
  recovery: 'recover',
};

export function standInVector(text: string): number[] {
  const vector = new Array<number>(1024).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const ch of MEANS[word] ?? word) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    vector[hash % vector.length] += 1;
  }
  return vector;
}
