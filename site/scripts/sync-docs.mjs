#!/usr/bin/env node
// Copies the app's user guides into the site before every build.
//
// The guides live in packages/simply-confluence-explorer/docs/, next to the code they describe, so
// they can be read on GitHub and are checked by the package's tests (test/docs/guides.test.ts). The
// site renders that folder as it is: getting started, the guides, and the images they show by
// relative path. The copies are gitignored and rebuilt on every run; nothing they hold is edited
// here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const source = path.resolve(siteRoot, '../packages/simply-confluence-explorer/docs');
const target = path.join(siteRoot, 'src/content/docs');

for (const entry of ['getting-started.md', 'guides', 'images']) {
  fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  fs.cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
}

const guides = fs.readdirSync(path.join(target, 'guides')).filter((f) => f.endsWith('.md'));
console.log(`sync-docs: getting started and ${guides.length} guide(s) copied from ${path.relative(siteRoot, source)}`);
