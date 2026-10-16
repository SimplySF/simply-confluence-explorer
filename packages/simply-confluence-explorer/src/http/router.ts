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
import type { ErrorResponse } from '../api/types.js';
import { errorMessage } from '../util/errors.js';
import { FIELDS, PARAMS } from './guards.js';

/** An error that carries the HTTP status it should be answered with. */
export class HttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What a route handler receives. */
export type ApiRequest = {
  method: string;
  pathname: string;
  /** Route parameters, already checked against `PARAMS`. */
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  /** The parsed JSON body, or `undefined` when the request had none. */
  body: unknown;
  /** The raw response, for a handler that streams instead of returning JSON. */
  res: http.ServerResponse;
};

/**
 * A route handler. Whatever it returns is sent as JSON with status 200. A handler that writes the
 * response itself, such as a file download, returns `undefined`.
 */
export type Handler = (req: ApiRequest) => unknown;

type Route = {
  method: string;
  segments: string[];
  handler: Handler;
};

/** Request bodies above this size are refused, which bounds the memory one request can take. */
export const MAX_BODY_BYTES = 50 * 1024 * 1024;

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The server's `/api` routes. It stands in for a web framework and does only what this app needs:
 * it matches a method and path, checks every route parameter and every path-shaped body field,
 * parses JSON bodies, and turns a thrown error into a JSON reply without a stack trace.
 */
export class Router {
  private readonly routes: Route[] = [];

  public constructor(private readonly log: (message: string) => void) {}

  /**
   * Adds a route. A parameter is written as `:name`, and its name must be one of `PARAMS`, so no
   * route can take a parameter that nothing checks.
   */
  public add(method: string, pattern: string, handler: Handler): this {
    const segments = pattern.split('/').filter(Boolean);
    for (const segment of segments) {
      if (segment.startsWith(':') && !(segment.slice(1) in PARAMS)) {
        throw new Error(`route ${pattern} uses the parameter ${segment}, which has no check in PARAMS`);
      }
    }
    this.routes.push({ method, segments, handler });
    return this;
  }

  /**
   * Answers a request whose path is under `/api`.
   */
  public async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // The raw path, because URL parsing resolves an encoded `%2E%2E` into a parent directory before
    // the parameter checks could see it and refuse it.
    const rawPath = (req.url ?? '/').split('?')[0];
    const method = req.method ?? 'GET';
    try {
      const { route, params } = this.match(method, rawPath);
      const body = METHODS_WITH_BODY.has(method) ? await readJsonBody(req) : undefined;
      checkFields(body, url.searchParams);
      const result: unknown = await route.handler({
        method,
        pathname: rawPath,
        params,
        query: url.searchParams,
        body,
        res,
      });
      if (!res.headersSent) sendJson(res, 200, result ?? {});
    } catch (error) {
      this.fail(res, method, rawPath, error);
    }
  }

  private match(method: string, pathname: string): { route: Route; params: Record<string, string> } {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    if (pathMatched) throw new HttpError(405, `${method} is not allowed on ${pathname}`);
    throw new HttpError(404, `No API route for ${method} ${pathname}`);
  }

  private fail(res: http.ServerResponse, method: string, pathname: string, error: unknown): void {
    const declared = (error as { status?: unknown }).status;
    const status = typeof declared === 'number' && declared >= 400 && declared < 600 ? declared : 500;
    const message = errorMessage(error);
    if (status >= 500) this.log(`[${method} ${pathname}] ${message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // A refusal from the outbound guard says what kind of thing it found and where, never the value.
    const findings = (error as { findings?: unknown }).findings;
    const body: ErrorResponse & { findings?: unknown } = findings ? { error: message, findings } : { error: message };
    sendJson(res, status, body);
  }
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | undefined {
  if (pattern.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, segment] of pattern.entries()) {
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      const value = safeDecode(parts[i]);
      if (value === undefined || !PARAMS[name].valid(value)) throw new HttpError(400, `invalid ${PARAMS[name].label}`);
      params[name] = value;
    } else if (segment !== parts[i]) {
      return undefined;
    }
  }
  return params;
}

function safeDecode(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    // Malformed percent-encoding cannot be a valid parameter; the caller answers 400.
    return undefined;
  }
}

function checkFields(body: unknown, query: URLSearchParams): void {
  const fromBody = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  for (const [field, valid] of FIELDS) {
    for (const value of [fromBody[field], query.get(field)]) {
      if (value === undefined || value === null || value === '') continue;
      // Only a string or a number can name a space or a page; anything else is refused outright.
      const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
      if (!valid(text)) throw new HttpError(400, `invalid ${field}`);
    }
  }
}

/**
 * Reads a request body as JSON. A body in any other format is refused, because a plain HTML form
 * cannot send JSON, so a form on another website cannot post to this server.
 */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body is too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'request bodies must be JSON');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

/**
 * Sends a JSON response.
 */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}
