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

// Every test run gets one temporary folder of its own, and it is deleted when the run ends. Tests make
// their data folders with os.tmpdir(), which reads TMPDIR on Linux and macOS and TEMP or TMP on
// Windows, so pointing those at the run's folder catches every one, including tests written later.
// Without it, each run left thousands of files behind, and a day of runs filled the system's
// temporary folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-run-'));
  // The test workers start after this and inherit the environment.
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = root;
  return () => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      // A file Windows still holds open can stop the delete; the run's results stand, so this is
      // reported rather than failing it.
      process.stderr.write(`Could not remove the test run's temporary folder ${root}: ${String(error)}\n`);
    }
  };
}
