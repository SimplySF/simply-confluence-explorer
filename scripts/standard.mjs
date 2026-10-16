#!/usr/bin/env node
/**
 * Runs the development standard's conformance check, which is kept beside this checkout rather than
 * inside it. When the check is not there, this prints that it was skipped instead of failing, so a
 * contributor who does not have the standard can still build and test. Set STANDARD_CHECK to use a
 * check kept somewhere else.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const check = process.env.STANDARD_CHECK ?? fileURLToPath(new URL('../../agent-context/check.sh', import.meta.url));

if (!existsSync(check)) {
  console.log('the development standard is not beside this checkout; skipped');
} else {
  const result = spawnSync('sh', [check, '.'], { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.log(`the conformance check needs a POSIX shell (${result.error.message}); skipped`);
  } else {
    process.exitCode = result.status ?? 1;
  }
}
