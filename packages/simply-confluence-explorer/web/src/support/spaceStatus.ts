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

// The line under a space's name in the sidebar: how much of it is on this machine, and how fresh.

import type { SyncedSpace } from '../../../src/api/types.js';

/** "2 h ago": how long since a moment, in the largest whole unit. */
export function ago(at: string | number, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (60 * 24))} d ago`;
}

/** "44 synced · 2 h ago", or "Not synced" for a space read live from Confluence. */
export function syncLine(
  manifest: Pick<SyncedSpace, 'pageCount' | 'lastSynced'> | undefined,
  now = Date.now(),
): string {
  return manifest
    ? `${manifest.pageCount.toLocaleString('en-US')} synced · ${ago(manifest.lastSynced, now)}`
    : 'Not synced';
}
