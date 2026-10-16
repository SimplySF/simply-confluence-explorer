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

import os from 'node:os';
import path from 'node:path';

/** The environment variable that moves the data directory when no `--data-dir` flag is given. */
export const DATA_DIR_ENV = 'CONFLUENCE_EXPLORER_DATA';

/**
 * Decides where the app keeps everything it writes (design doc 0003). The `--data-dir` flag wins,
 * then the environment variable, then `~/.confluence-explorer`. The result is resolved once at
 * startup and passed to every store, so no module works out its own location.
 */
export function resolveDataDir(flag: string | undefined, env: NodeJS.ProcessEnv, home = os.homedir()): string {
  return path.resolve(flag ?? env[DATA_DIR_ENV] ?? path.join(home, '.confluence-explorer'));
}
