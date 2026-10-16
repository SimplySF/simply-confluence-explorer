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

import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes JSON that only the user running the server can read: mode 0600, in a directory with mode
 * 0700. The data goes to a temporary file first and is then renamed into place, so a crash part
 * way through never leaves half a token on disk. Windows ignores these modes; there, the file is
 * protected by the permissions of the user's profile directory, and the doctor says so.
 */
export function writePrivateJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/**
 * Reads a JSON file, treating a missing file as empty. A file that exists but cannot be parsed is
 * an error rather than an empty configuration, so a damaged settings file is reported instead of
 * silently discarded.
 */
export function readJsonOrEmpty<T>(file: string): T {
  if (!fs.existsSync(file)) return {} as T;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
