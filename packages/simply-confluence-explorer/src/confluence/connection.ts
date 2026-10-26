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

import path from 'node:path';
import type { ConnectionSource, ConnectionUpdate, ConnectionView } from '../api/types.js';
import { readJsonOrEmpty, writePrivateJson } from '../util/privateFile.js';

// The server holds the Confluence connection, and a request never chooses its own (ADR-019). The
// token is written here and never sent back to a browser. When CONFLUENCE_URL is set in the
// environment, the environment is the deployment's own configuration and Settings cannot change it.
// The variable names are simply-atlassian-core's, so one .env file serves this app and the simply
// command alike.

type Stored = {
  baseUrl?: string;
  token?: string;
  timeoutSeconds?: number;
};

/**
 * How long a request to Confluence may take. A company's Confluence can be slow to answer, as when
 * a page has many children, so the limit can be raised in Settings or by `CONFLUENCE_TIMEOUT_SECONDS`.
 */
export const TIMEOUT_SECONDS = { default: 30, min: 5, max: 600 };
const timeoutOf = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isInteger(n) && n >= TIMEOUT_SECONDS.min && n <= TIMEOUT_SECONDS.max ? n : undefined;
};

/** A connection as the server uses it, including the token. Never sent to a browser. */
export type ResolvedConnection = {
  baseUrl: string;
  token: string;
  source: ConnectionSource;
  timeoutSeconds: number;
};

const normalize = (url: string): string => url.trim().replace(/\/+$/, '');

export class ConnectionStore {
  private readonly file: string;

  public constructor(
    dataDir: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.file = path.join(dataDir, 'config', 'connection.json');
  }

  /** The connection in use: the environment's when it sets a URL, otherwise the saved one. */
  public resolve(): ResolvedConnection {
    const saved = readJsonOrEmpty<Stored>(this.file);
    const timeoutSeconds =
      timeoutOf(this.env.CONFLUENCE_TIMEOUT_SECONDS) ?? timeoutOf(saved.timeoutSeconds) ?? TIMEOUT_SECONDS.default;
    if (this.env.CONFLUENCE_URL) {
      return {
        baseUrl: normalize(this.env.CONFLUENCE_URL),
        token: this.env.CONFLUENCE_PERSONAL_TOKEN ?? '',
        source: 'env',
        timeoutSeconds,
      };
    }
    return {
      baseUrl: normalize(saved.baseUrl ?? ''),
      token: saved.token ?? '',
      source: saved.baseUrl ? 'settings' : 'none',
      timeoutSeconds,
    };
  }

  /** What a browser may see: whether a token is set, but never the token. */
  public publicView(): ConnectionView {
    const current = this.resolve();
    return {
      baseUrl: current.baseUrl,
      tokenSet: current.token !== '',
      source: current.source,
      editable: current.source !== 'env',
      profile: this.env.CONFLUENCE_EXPLORER_PROFILE ?? '',
      timeoutSeconds: current.timeoutSeconds,
      timeoutEditable: timeoutOf(this.env.CONFLUENCE_TIMEOUT_SECONDS) === undefined,
    };
  }

  /**
   * Builds a connection to test before it is saved. The saved token is reused only for the URL it
   * was saved with, so a different URL typed into Settings is never sent the saved token.
   */
  public candidate(change: ConnectionUpdate): Omit<ResolvedConnection, 'source'> {
    const current = this.resolve();
    const baseUrl = normalize(change.baseUrl ?? current.baseUrl);
    const timeoutSeconds = timeoutOf(change.timeoutSeconds) ?? current.timeoutSeconds;
    if (change.token) return { baseUrl, token: change.token, timeoutSeconds };
    return { baseUrl, token: baseUrl === current.baseUrl ? current.token : '', timeoutSeconds };
  }

  /**
   * Saves a change made in Settings.
   */
  public update(change: ConnectionUpdate): void {
    if (change.timeoutSeconds !== undefined && timeoutOf(change.timeoutSeconds) === undefined)
      throw new Error(
        `The time limit must be a whole number of seconds from ${TIMEOUT_SECONDS.min} to ${TIMEOUT_SECONDS.max}`,
      );
    if (this.env.CONFLUENCE_URL && (change.baseUrl !== undefined || change.token !== undefined)) {
      throw new Error('The connection is set by the server environment (CONFLUENCE_URL) and cannot be changed here.');
    }
    if (change.baseUrl !== undefined && !/^https?:\/\/[^\s/]+/.test(change.baseUrl.trim())) {
      throw new Error('The Confluence URL must start with http:// or https://');
    }
    const next = readJsonOrEmpty<Stored>(this.file);
    const urlChanged = change.baseUrl !== undefined && normalize(change.baseUrl) !== normalize(next.baseUrl ?? '');
    if (change.baseUrl !== undefined) next.baseUrl = normalize(change.baseUrl);
    // A token belongs to the URL it was issued for, so a new URL without a new token drops the old one.
    if (change.token !== undefined) next.token = change.token.trim() || undefined;
    else if (urlChanged) next.token = undefined;
    if (change.timeoutSeconds !== undefined) next.timeoutSeconds = change.timeoutSeconds;
    writePrivateJson(this.file, next);
  }
}
