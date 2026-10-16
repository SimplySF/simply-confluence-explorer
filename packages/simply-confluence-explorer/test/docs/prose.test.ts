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

// These tests check the documentation the way a compiler checks code. The documents make claims
// about which commands exist, what the budgets are, which decisions were made and where the
// load-bearing code lives. Nothing else notices when such a claim stops being true, so each test
// below compares one kind of claim with the file that actually decides it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const pkg = 'packages/simply-confluence-explorer';
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel));
const markdownIn = (dir: string): string[] =>
  fs
    .readdirSync(path.join(root, dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `${dir}/${f}`);

const designDocs = markdownIn('docs/design').filter((d) => d !== 'docs/design/README.md');
const statusOf = (doc: string): string => /^\*\*Status:\*\* *(\S+)/m.exec(read(doc))?.[1] ?? '';

const DOCS = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  `${pkg}/README.md`,
  `${pkg}/CONTRIBUTING.md`,
  'test-env/README.md',
  ...markdownIn('docs'),
  'docs/design/README.md',
  ...designDocs,
];

// Two kinds of document are not held to the current commands. The decision log describes each
// decision as it was made, so a command it names may since have been removed by a later record. A
// design doc that is not implemented yet describes a plan, not the program as it is.
const LIVE_DOCS = DOCS.filter(
  (d) => d !== 'docs/decisions.md' && !(designDocs.includes(d) && statusOf(d) !== 'Implemented'),
);

// Commands are written in fenced code blocks or backticked spans, so only those are searched.
const inCode = (text: string): string => (text.match(/```[\s\S]*?```|`[^`\n]+`/g) ?? []).join('\n');

const scriptsOf = (manifest: string): string[] =>
  Object.keys((JSON.parse(read(manifest)) as { scripts?: Record<string, string> }).scripts ?? {});

// AGENTS.md lists, under "Not yet armed", the checks that nothing enforces yet. A documented
// command that does not exist yet is allowed only while that section names it.
function notYetArmed(): string {
  const agents = read('AGENTS.md');
  const start = agents.indexOf('### Not yet armed');
  expect(start, 'AGENTS.md has no "Not yet armed" section').toBeGreaterThanOrEqual(0);
  return agents.slice(start);
}

function documentedScripts(): Map<string, string> {
  const found = new Map<string, string>();
  for (const doc of LIVE_DOCS) {
    const code = inCode(read(doc));
    for (const m of code.matchAll(/pnpm run ([a-z][a-z0-9:-]*[a-z0-9])/g)) found.set(m[1], doc);
    if (/pnpm test\b/.test(code)) found.set('test', doc);
    if (/pnpm start\b/.test(code)) found.set('start', doc);
  }
  return found;
}

// Scripts that tools run on their own, such as husky's install hook. Nobody is told to type them, so
// they need no documentation.
const INTERNAL_SCRIPTS = new Set(['prepare']);

function adrSection(number: string): string {
  const log = read('docs/decisions.md');
  const start = log.indexOf(`## ADR-${number} `);
  expect(start, `ADR-${number} not found`).toBeGreaterThanOrEqual(0);
  const next = log.indexOf('\n## ADR-', start + 1);
  return log.slice(start, next < 0 ? undefined : next);
}

function walk(dir: string): string[] {
  if (!exists(dir)) return [];
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(rel);
    return /\.(ts|svelte|mjs)$/.test(entry.name) ? [rel] : [];
  });
}

// Load-bearing modules that a later change will move into this package. The list is closed in both
// directions: a path listed here that already exists fails the test, so the list shrinks as each
// module lands, and a missing path that is not listed here fails too.
const NOT_YET_MOVED = new Set([
  'confluence/pagePush.ts',
  'branches/branchRuns.ts',
  'drafts/drafts.ts',
  'ai/providers.ts',
  'ai/guard.ts',
  'ai/engine.ts',
  'ai/sessions.ts',
  'ai/settings.ts',
  'ai/geminiService.ts',
]);

describe('the documentation', () => {
  it('names only pnpm scripts that exist, or says they are not armed yet', () => {
    const scripts = new Set([...scriptsOf('package.json'), ...scriptsOf(`${pkg}/package.json`)]);
    const documented = documentedScripts();
    expect(documented.size, 'has the pattern rotted?').toBeGreaterThanOrEqual(8);
    const pending = notYetArmed();
    for (const [script, doc] of documented) {
      if (scripts.has(script)) continue;
      expect(pending, `${doc} documents \`pnpm run ${script}\`, which is not in package.json`).toContain(
        `pnpm run ${script}`,
      );
    }
  });

  it('documents every root script a person runs', () => {
    const documented = documentedScripts();
    for (const script of scriptsOf('package.json')) {
      if (INTERNAL_SCRIPTS.has(script)) continue;
      expect(documented.has(script), `\`pnpm run ${script}\` exists but no document mentions it`).toBe(true);
    }
  });

  it('lists in "Not yet armed" only commands that are still missing', () => {
    const scripts = new Set(scriptsOf('package.json'));
    for (const m of notYetArmed().matchAll(/`pnpm run ([a-z][a-z0-9:-]*[a-z0-9])`/g)) {
      expect(scripts.has(m[1]), `\`pnpm run ${m[1]}\` exists; retire it from "Not yet armed"`).toBe(false);
    }
  });

  it('indexes every design doc with the status the doc itself states', () => {
    const index = read('docs/design/README.md');
    const rows = new Map(
      [...index.matchAll(/^\| \[(\d{4})\]\(([\w.-]+)\) +\|.*\| *(\S+)[^|]*\|$/gm)].map((m) => [
        `docs/design/${m[2]}`,
        m[3],
      ]),
    );
    expect(new Set(rows.keys())).toEqual(new Set(designDocs));
    for (const [doc, status] of rows) expect(statusOf(doc), `${doc} status differs from the index`).toBe(status);
  });

  it('names a load-bearing path in AGENTS.md only if it exists or is known not to have moved yet', () => {
    const agents = read('AGENTS.md');
    const table = agents.slice(agents.indexOf('### Load-bearing surfaces'), agents.indexOf('### The rules specific'));
    const paths = [...table.matchAll(/`([\w-]+\/[\w./-]+\.ts)`/g)].map((m) => m[1]);
    expect(paths.length, 'has the pattern rotted?').toBeGreaterThanOrEqual(8);
    for (const p of paths) {
      const present = exists(`${pkg}/src/${p}`) || exists(`${pkg}/${p}`);
      if (NOT_YET_MOVED.has(p)) expect(present, `${p} has moved in; remove it from NOT_YET_MOVED`).toBe(false);
      else expect(present, `AGENTS.md names ${p}, which does not exist`).toBe(true);
    }
    for (const p of NOT_YET_MOVED) expect(paths, `NOT_YET_MOVED names ${p}, which AGENTS.md does not`).toContain(p);
  });
});

describe('the decision log', () => {
  it('is numbered without gaps, and every record states its status', () => {
    const numbers = [...read('docs/decisions.md').matchAll(/^## ADR-(\d{3}) — /gm)].map((m) => Number(m[1]));
    expect(numbers.length).toBeGreaterThanOrEqual(10);
    numbers.forEach((n, i) => expect(n, `ADR numbering jumps at position ${i + 1}`).toBe(i + 1));
    for (const n of numbers) expect(adrSection(String(n).padStart(3, '0'))).toMatch(/\*\*Status:\*\*/);
  });

  // The log is append-only, so when a budget is added or changed, a new record says so. Each limit
  // in scripts/budgets.mjs must cite the record that set it, and that record must name the budget.
  it('backs every budget, and every budget a record names is asserted', () => {
    const lines = [
      ...read('scripts/budgets.mjs').matchAll(/^const (M(?:AX|IN)_[A-Z_]+) = \S+; *\/\/ *(ADR-(\d{3}))?/gm),
    ];
    const declared = new Set(lines.map((m) => m[1]));
    expect(declared.size).toBeGreaterThanOrEqual(5);
    for (const [, name, cited, number] of lines) {
      expect(cited, `${name} cites no decision record`).toBeDefined();
      expect(adrSection(number), `${name} cites ${cited}, which does not name it`).toContain(`\`${name}\``);
    }
    const named = new Set([...read('docs/decisions.md').matchAll(/`(M(?:AX|IN)_[A-Z_]+)`/g)].map((m) => m[1]));
    for (const budget of named) expect(declared.has(budget), `the log names ${budget}; nothing asserts it`).toBe(true);
  });

  it('holds every record that something cites', () => {
    const records = new Set([...read('docs/decisions.md').matchAll(/^## ADR-(\d{3}) /gm)].map((m) => m[1]));
    const files = [
      ...DOCS,
      'scripts/budgets.mjs',
      ...walk(`${pkg}/src`),
      ...walk(`${pkg}/test`),
      ...walk(`${pkg}/web`),
    ];
    let cited = 0;
    for (const file of files) {
      for (const m of read(file).matchAll(/ADR-(\d{3})/g)) {
        cited++;
        expect(records.has(m[1]), `${file} cites ADR-${m[1]}, which is not in docs/decisions.md`).toBe(true);
      }
    }
    expect(cited, 'has the pattern rotted?').toBeGreaterThanOrEqual(10);
  });
});
