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

/**
 * Turns a page title or space key into a name that is safe to use as one path segment. Characters
 * that file systems reserve are replaced, and a name made only of dots becomes `_`, because `.` and
 * `..` refer to directories rather than naming a file.
 */
export function sanitizeFilename(name: string): string {
  const clean = name.replace(/[/\\?%*:|"<>]/g, '_').trim();
  if (/^\.+$/.test(clean)) return '_';
  return clean || 'untitled';
}

/**
 * Resolves a path inside `base` and refuses any result that would land outside it. Every path built
 * from a request value goes through this, so a mistake in validation upstream still cannot reach a
 * file outside the app's data directory.
 */
export function within(base: string, ...parts: string[]): string {
  const root = path.resolve(base);
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('path escapes its data directory');
  }
  return target;
}
