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

import type http from 'node:http';

// Route parameters and some body fields become directory and file names under the data directory,
// so each one is checked against the shape Confluence actually issues before any handler sees it.

// Space keys are letters, digits and underscores. Personal spaces start with ~ followed by a
// username, which may contain dots and hyphens.
const SPACE_KEY = /^~?[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const PAGE_ID = /^\d{1,20}$/;
const JOB_ID = /^[a-z]+_\d+_[a-z0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isValidSpaceKey = (key: unknown): key is string =>
  typeof key === 'string' && SPACE_KEY.test(key) && !key.includes('..');

export const isValidPageId = (id: unknown): id is string => typeof id === 'string' && PAGE_ID.test(id);

/** Every route parameter name the router accepts, with the check its value must pass. */
export const PARAMS: Readonly<Record<string, { label: string; valid: (value: string) => boolean }>> = {
  spaceKey: { label: 'space key', valid: isValidSpaceKey },
  pageId: { label: 'page id', valid: isValidPageId },
  jobId: { label: 'job id', valid: (v) => JOB_ID.test(v) },
  sessionId: { label: 'session id', valid: (v) => UUID.test(v) },
  fileId: { label: 'file id', valid: (v) => UUID.test(v) },
  runId: { label: 'run id', valid: (v) => UUID.test(v) },
  provider: { label: 'provider', valid: (v) => /^[a-z-]{1,32}$/.test(v) },
  turn: { label: 'turn number', valid: (v) => /^\d{1,4}$/.test(v) },
  traceId: { label: 'trace id', valid: (v) => /^[0-9a-f]{16}$/.test(v) },
  changeId: { label: 'change id', valid: (v) => /^[0-9a-f]{12}$/.test(v) },
  suggestionId: { label: 'suggestion id', valid: (v) => /^[0-9a-f]{12}$/.test(v) },
  attachment: { label: 'attachment number', valid: (v) => /^\d{1,4}$/.test(v) },
};

/**
 * Fields that arrive in request bodies and query strings and reach the same paths as the route
 * parameters above, so they are held to the same checks.
 */
export const FIELDS: ReadonlyArray<[string, (value: string) => boolean]> = [
  ['spaceKey', isValidSpaceKey],
  ['pageId', isValidPageId],
  ['rootPageId', isValidPageId],
];

const LOCAL_NAMES = ['localhost', '127.0.0.1', '::1'];

const bareHost = (host: string): string =>
  host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();

function originHost(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    // An Origin header that is not a URL cannot name an allowed host, so it is refused below.
    return '';
  }
}

/**
 * Builds the check that keeps the server answering this machine only (ADR-018). A request is
 * refused when its Host header names anything other than this machine, which stops a website that
 * points its own domain name at 127.0.0.1. It is also refused when a browser reports that another
 * site sent it, which stops other websites calling the API from a visitor's browser.
 * ALLOWED_HOSTS adds names for a deployment that is reached by another name.
 */
export function localOnly(env: NodeJS.ProcessEnv): (req: http.IncomingMessage) => boolean {
  const extra = (env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set([...LOCAL_NAMES, ...extra]);
  return (req) => {
    const { origin } = req.headers;
    if (!allowed.has(bareHost(req.headers.host ?? ''))) return false;
    if (origin !== undefined && !allowed.has(originHost(origin))) return false;
    return req.headers['sec-fetch-site'] !== 'cross-site';
  };
}
