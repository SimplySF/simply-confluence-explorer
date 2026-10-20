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
import { ConfiguredAi, type EmbedTransport, type Transport } from './ai/engine.js';
import { SessionStore } from './ai/sessions.js';
import { AiSettingsStore } from './ai/settings.js';
import { BranchRunner } from './branches/branchRuns.js';
import { ConfluenceClient } from './confluence/client.js';
import { ExclusionManager } from './spaces/exclusionManager.js';
import { CorpusReviews } from './branches/corpusReview.js';
import { MetadataPipeline } from './spaces/metadata.js';
import { CONTEXT_CHAR_LIMIT } from './spaces/branchContext.js';
import { corpusSize } from './spaces/contextRetriever.js';
import { SearchIndex } from './spaces/searchIndex.js';
import { tagsOf } from './spaces/tags.js';
import { Telemetry } from './telemetry/telemetry.js';
import { VectorIndex } from './spaces/vectors.js';
import { GitLabStore } from './gitlab/client.js';
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
  /**
   * Sends AI requests in place of the configured provider. Tests pass one, so that what would be
   * sent can be checked and nothing leaves the machine.
   */
  aiTransport?: Transport;
  /** Embeds texts in place of the configured provider, for the same reason. */
  embedTransport?: EmbedTransport;
  /**
   * How many characters of pages one chat request may carry. Tests set it low, so the small test
   * spaces are retrieved from as a large space is.
   */
  contextChars?: number;
  /** Whether telemetry samples health and writes in batches; tests that read it back at once turn it off. */
  telemetryTimers?: boolean;
  /** How long the AI index waits before trying a failed request again; tests set it to 0. */
  indexRetryMs?: number;
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
  // Everything the server reports goes through telemetry, which also prints warnings and errors to
  // the given log, so a message is kept on disk as well as shown in the console (ADR-054).
  const telemetry = new Telemetry({ dataDir, console: options.log, timers: options.telemetryTimers });
  const log = telemetry.sink('server');
  const connection = new ConnectionStore(dataDir, env);
  const client = (): ConfluenceClient => new ConfluenceClient(connection.resolve());
  const exclusions = new ExclusionManager(dataDir, log);
  const store = new SpaceStore(dataDir, exclusions, telemetry.sink('sync'));
  const gitlab = new GitLabStore(dataDir);
  const ai = new ConfiguredAi(new AiSettingsStore(dataDir, env), {
    dataDir,
    env,
    log: telemetry.sink('ai'),
    transport: options.aiTransport,
    embedTransport: options.embedTransport,
    tracer: telemetry,
  });
  const vectors = new VectorIndex(store);
  const index = new SearchIndex(store);
  const sessions = new SessionStore(dataDir);
  const contextChars = options.contextChars ?? CONTEXT_CHAR_LIMIT;
  const sync = new SpaceSync(store, exclusions, client, telemetry.sink('sync'), telemetry);
  const metadata = new MetadataPipeline(store, exclusions, () => ai, telemetry.sink('index'), vectors, telemetry, {
    retryDelayMs: options.indexRetryMs,
  });
  const reviews = new CorpusReviews({
    ai,
    sessions,
    exclusions,
    readMetadataTopics: (key, page): string[] => tagsOf(page, store.readMetadata(key, page.id)),
    pageSize: (key, page): number => corpusSize(key, [page], index),
    dataDir,
    budget: contextChars,
    log: telemetry.sink('review'),
    tracer: telemetry,
  });
  for (const source of [sync, metadata, reviews]) telemetry.addJobSource(() => source.liveJobs());
  telemetry.addJobSource(() =>
    index.building().map((b) => ({
      jobId: `index-${b.spaceKey}`,
      kind: 'search-index',
      label: `Building the search index for ${b.spaceKey}`,
      processed: b.done,
      total: b.total,
    })),
  );
  // Synced spaces are indexed as soon as the server starts, so the first question does not wait for it.
  setImmediate(() => {
    for (const space of store.listSynced()) void index.ready(space.spaceKey);
  });
  const api = createApi({
    version,
    dataDir,
    env,
    log,
    connection,
    client,
    exclusions,
    store,
    sync,
    ai,
    sessions,
    metadata,
    branches: new BranchRunner({ ai, client, store, exclusions, dataDir, log: telemetry.sink('review') }),
    index,
    vectors,
    contextChars,
    reviews,
    gitlab,
    telemetry,
  });
  const isLocal = localOnly(env);

  const server = http.createServer((req, res) => {
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
  server.on('close', () => telemetry.close());
  return server;
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
