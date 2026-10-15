#!/usr/bin/env node

import { main } from '../lib/cli.js';

try {
  await main({ log: (message) => console.log(message) });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
