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
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { createServer, type ServerOptions } from './server.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4280;

export const USAGE = `Usage: confluence-explorer [options]

Starts the Confluence Explorer web app.

Options:
  -p, --port <port>  Port to listen on (env: PORT, default: ${DEFAULT_PORT}; 0 picks a free port)
      --host <host>  Interface to bind (env: HOST, default: ${DEFAULT_HOST})
  -h, --help         Show this help`;

export type MainOptions = ServerOptions & {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
};

/**
 * Parses the command line, starts the server, and logs where it is listening.
 *
 * @param options Arguments, environment, and output sink; each defaults to the real process's.
 * @returns The listening server, or `undefined` when `--help` was asked for.
 */
export async function main(options: MainOptions = {}): Promise<http.Server | undefined> {
  const { argv = process.argv.slice(2), env = process.env, log = (): void => {}, ...serverOptions } = options;

  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      host: { type: 'string' },
      port: { type: 'string', short: 'p' },
    },
    strict: true,
  });

  if (values.help) {
    log(USAGE);
    return undefined;
  }

  const host = values.host ?? env.HOST ?? DEFAULT_HOST;
  const port = parsePort(values.port ?? env.PORT ?? String(DEFAULT_PORT));

  const server = createServer(serverOptions);
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

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port "${raw}": expected an integer from 0 to 65535.`);
  }
  return port;
}
