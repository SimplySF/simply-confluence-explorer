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

import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where `vite build` writes the frontend, relative to both `src/` and the compiled `lib/`. */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../dist/web/', import.meta.url));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export type ServerOptions = {
  /** Directory holding the built frontend. Defaults to the package's own `dist/web`. */
  webRoot?: string;
  /** Reported by `GET /api/health`. Defaults to this package's version. */
  version?: string;
};

export type HealthResponse = {
  status: 'ok';
  version: string;
};

/**
 * Creates (but does not start) the explorer's HTTP server: JSON routes under `/api/`, and the built
 * frontend for everything else, falling back to `index.html` so client-side routes survive a reload.
 *
 * @param options Where the frontend lives and what version to report.
 * @returns An unstarted `http.Server`; call `listen` on it.
 */
export function createServer(options: ServerOptions = {}): http.Server {
  const webRoot = path.resolve(options.webRoot ?? DEFAULT_WEB_ROOT);
  const version = options.version ?? readPackageVersion();

  return http.createServer((req, res) => {
    handleRequest(req, res, webRoot, version).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'Internal server error' });
      } else {
        res.destroy();
      }
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webRoot: string,
  version: string,
): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    if (pathname === '/api/health' && req.method === 'GET') {
      const body: HealthResponse = { status: 'ok', version };
      sendJson(res, 200, body);
    } else {
      sendJson(res, 404, { error: `No API route for ${req.method ?? 'GET'} ${pathname}` });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  const file = (await resolveStaticFile(webRoot, pathname)) ?? (await resolveStaticFile(webRoot, '/index.html'));
  if (!file) {
    res
      .writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('The web app has not been built. Run `pnpm run build` first.\n');
    return;
  }

  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Maps a URL path to a file under `webRoot`, refusing anything that would escape it. */
async function resolveStaticFile(webRoot: string, pathname: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }

  const candidate = path.resolve(webRoot, `.${decoded.endsWith('/') ? `${decoded}index.html` : decoded}`);
  if (candidate !== webRoot && !candidate.startsWith(webRoot + path.sep)) {
    return undefined;
  }

  try {
    return (await stat(candidate)).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}
