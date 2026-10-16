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

import { existsSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnvFile } from '@simplysf/simply-atlassian-core';
import { ConnectionStore } from './confluence/connection.js';
import { renderDoctor, runDoctor } from './doctor/checks.js';
import { systemDeps } from './doctor/system.js';
import { createServer, type ServerOptions } from './server.js';
import { DATA_DIR_ENV, resolveDataDir } from './util/dataDir.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4280;

export const USAGE = `Usage: confluence-explorer [options]
       confluence-explorer doctor [--json] [--data-dir <path>]

Starts the Confluence Explorer web app. \`doctor\` checks the setup instead and says what to fix.

Options:
  -p, --port <port>      Port to listen on (env: PORT, default: ${DEFAULT_PORT}; 0 picks a free port)
      --host <host>      Interface to bind (env: HOST, default: ${DEFAULT_HOST})
      --data-dir <path>  Where the app keeps its data (env: ${DATA_DIR_ENV}, default: ~/.confluence-explorer)
      --json             With doctor, print the report as JSON
  -h, --help             Show this help`;

export type MainOptions = ServerOptions & {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
};

/**
 * Parses the command line, starts the server, and logs where it is listening.
 *
 * @param options Arguments, environment, and output sink; each defaults to the real process's.
 * @returns The listening server, or `undefined` when `--help` or `doctor` was asked for.
 */
export async function main(options: MainOptions = {}): Promise<http.Server | undefined> {
  const { argv = process.argv.slice(2), log = (): void => {}, ...serverOptions } = options;

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      host: { type: 'string' },
      json: { type: 'boolean' },
      port: { type: 'string', short: 'p' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    log(USAGE);
    return undefined;
  }
  if (positionals.length > 1 || (positionals.length === 1 && positionals[0] !== 'doctor')) {
    throw new Error(`Unknown command "${positionals.join(' ')}". Run confluence-explorer --help for usage.`);
  }

  const dataDir = resolveDataDir(values['data-dir'] ?? serverOptions.dataDir, options.env ?? process.env);
  const env = withEnvFile(options.env ?? process.env, dataDir);

  if (positionals[0] === 'doctor') {
    const report = runDoctor(systemDeps(dataDir, new ConnectionStore(dataDir, env), env));
    log(values.json ? JSON.stringify(report, null, 2) : renderDoctor(report));
    if (!report.ok) throw new Error('The doctor found a problem; see the fixes above.');
    return undefined;
  }

  const host = values.host ?? env.HOST ?? DEFAULT_HOST;
  const port = parsePort(values.port ?? env.PORT ?? String(DEFAULT_PORT));

  const server = createServer({ ...serverOptions, dataDir, env, log });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  log(`Confluence Explorer is running at http://${displayHost}:${address.port}/`);
  return server;
}

/**
 * Returns a copy of the environment with the Confluence variables from `<dataDir>/.env` added
 * wherever the environment does not already set them. The real environment always wins, and only
 * Atlassian connection variables are read from the file, so a stray .env cannot change anything
 * else about how the app runs.
 */
function withEnvFile(env: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  const merged = { ...env };
  const file = path.join(dataDir, '.env');
  if (existsSync(file)) loadEnvFile(file, merged);
  return merged;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port "${raw}": expected an integer from 0 to 65535.`);
  }
  return port;
}
