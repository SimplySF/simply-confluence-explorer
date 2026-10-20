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

// Which part of the Observability page is open (design doc 0008). Anything in the app can open it on
// a trace or a filtered log, and the address follows, so a view can be opened in another tab.

export type ObserveTab = 'now' | 'logs' | 'trace';
export type LogFilter = { levels?: string[]; kinds?: string[]; spaceKey?: string; q?: string; range?: string };

const SEEN_KEY = 'observe_seen';

class Observe {
  public open = $state(false);
  public tab = $state<ObserveTab>('now');
  public traceId = $state<string | null>(null);
  public filter = $state<LogFilter>({});
  /** When the person last looked, so the header counts only problems raised since. */
  public seenAt = $state(read(SEEN_KEY) ?? '');

  public show(tab: ObserveTab, options: { traceId?: string; filter?: LogFilter } = {}): void {
    this.tab = tab;
    if (options.traceId) this.traceId = options.traceId;
    if (options.filter) this.filter = options.filter;
    this.open = true;
    this.markSeen();
    this.writeHash();
  }

  public close(): void {
    this.open = false;
    this.writeHash();
  }

  public markSeen(): void {
    this.seenAt = new Date().toISOString();
    try {
      localStorage.setItem(SEEN_KEY, this.seenAt);
    } catch {
      // Without storage the count starts again on the next visit; nothing else depends on it.
    }
  }

  /** Opens the view the address names, such as `#/observe/trace/<id>`, after a reload or in a new tab. */
  public readHash(hash: string): void {
    const [, page, tab, id] = hash.split('/');
    if (page !== 'observe') {
      this.open = false;
      return;
    }
    this.open = true;
    this.markSeen();
    this.tab = tab === 'logs' || tab === 'trace' ? tab : 'now';
    if (tab === 'trace' && id) this.traceId = id;
  }

  private writeHash(): void {
    const hash = !this.open
      ? ''
      : this.tab === 'trace' && this.traceId
        ? `#/observe/trace/${this.traceId}`
        : `#/observe/${this.tab}`;
    if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname + location.search);
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage blocked: the header counts every problem in the last day instead.
    return null;
  }
}

export const observe = new Observe();
