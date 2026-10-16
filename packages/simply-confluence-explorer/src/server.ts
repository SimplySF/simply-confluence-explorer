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
import { ConnectionStore } from './confluence/connection.js';
import { localOnly } from './http/guards.js';
import { sendJson, type Router } from './http/router.js';
import { createApi } from './routes/api.js';
import { ConfluenceClient } from './confluence/client.js';
import { ExclusionManager } from './spaces/exclusionManager.js';
import { SpaceStore } from './spaces/spaceStore.js';
import { SpaceSync } from './spaces/sync.js';
import { resolveDataDir } from './util/dataDir.js';

export type { HealthResponse } from './routes/api.js';

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
  /** Where the app keeps what it writes (design doc 0003). Defaults to `~/.confluence-explorer`. */
  dataDir?: string;
  /** The environment the server reads its configuration from. Defaults to the real one. */
  env?: NodeJS.ProcessEnv;
  /** Where server errors are reported. Defaults to discarding them. */
  log?: (message: string) => void;
};

// Sent with every response. They stop the app being framed by another site, stop a browser
// guessing a content type the server did not send, and keep page URLs out of Referer headers. The
// content security policy lets the app load only its own scripts, while still showing images from
// the Confluence pages it renders.
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

/**
 * Creates (but does not start) the explorer's HTTP server: JSON routes under `/api/`, and the built
 * frontend for everything else, falling back to `index.html` so client-side routes survive a reload.
 *
 * @param options Where the frontend lives, what version to report, and where the app keeps its data.
 * @returns An unstarted `http.Server`; call `listen` on it.
 */
export function createServer(options: ServerOptions = {}): http.Server {
  const webRoot = path.resolve(options.webRoot ?? DEFAULT_WEB_ROOT);
  const version = options.version ?? readPackageVersion();
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? resolveDataDir(undefined, env);
  const log = options.log ?? ((): void => {});
  const connection = new ConnectionStore(dataDir, env);
  const exclusions = new ExclusionManager(dataDir, log);
  const store = new SpaceStore(dataDir, exclusions, log);
  const sync = new SpaceSync(store, exclusions, () => new ConfluenceClient(connection.resolve()), log);
  const api = createApi({ version, dataDir, env, log, connection, exclusions, store, sync });
  const isLocal = localOnly(env);

  return http.createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (!isLocal(req)) {
      sendJson(res, 403, { error: 'request refused: not from this machine' });
      return;
    }
    handleRequest(req, res, webRoot, api).catch((error: unknown) => {
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
  api: Router,
): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    await api.handle(req, res);
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

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}
