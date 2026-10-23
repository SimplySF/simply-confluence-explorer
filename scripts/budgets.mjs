#!/usr/bin/env node
/**
 * Measures the project's budgets: limits on its size and shape that keep growth a deliberate
 * decision. `pnpm run budgets` prints the measurements. The package's `test/budgets.test.ts` runs
 * this script with `--json` and fails on any budget past its limit, so `pnpm test` enforces the
 * budgets on every CI runner.
 *
 * Each limit below cites the decision record that set it. A limit may be lowered at any time, but
 * raising one needs a new decision record that argues for the new number (ADR-014).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CODE_LINES = 19300; // ADR-021, ADR-062, ADR-065, ADR-067, ADR-070, ADR-071, ADR-072: package src/ and web/src/, tests excluded
const MAX_COMMENT_RATIO = 25; // ADR-014: a hard ceiling; when it is exceeded, a comment is removed and the limit stays
const MAX_DOC_LINES = 2250; // ADR-034, ADR-055, ADR-062, ADR-067, ADR-070, ADR-072: every tracked .md except the decision log, history, review and the code of conduct
const MAX_GUIDE_LINES = 1150; // ADR-042, ADR-067: the user guides in packages/*/docs/, which ship in the package
const MAX_RUNTIME_DEPS = 7; // ADR-031: direct dependencies across every package.json
const MAX_DEV_DEPS = 29; // ADR-031: direct devDependencies across every package.json
const MAX_SITE_DEPS = 4; // ADR-043: the documentation site's dependencies, which never ship in the package
const MAX_BUNDLE_BYTES = 409600; // ADR-014: dist/web/assets, 400 KiB
const MIN_TEST_RATIO = 5; // ADR-021: at least one line of tests for every five lines of code
const MAX_CONFLUENCE_HTTP_MODULES = 1; // ADR-031: confluence/client.ts, and nothing else
const MAX_EXEC_MODULES = 1; // ADR-031: ai/geminiService.ts, and nothing else
const MAX_AI_SDK_MODULES = 1; // ADR-017: ai/providers.ts, and nothing else
const MAX_AI_SENDER_IMPORTERS = 1; // ADR-022: ai/engine.ts, where the outbound guard runs

const root = fileURLToPath(new URL('..', import.meta.url));
const packagesDir = join(root, 'packages');
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDir, entry.name));

function walk(dir, keep) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full, keep);
    return keep(entry.name) ? [full] : [];
  });
}

const rel = (file) => relative(root, file).split(sep).join('/');
// Line endings are made the same before anything is counted. A Windows checkout has \r\n endings,
// and without this the license-header pattern would miss every header there, counting them all as
// comments, so the budgets would measure differently on Windows than on Linux.
const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// The code that ships: the server and the frontend, without tests or type declarations.
const serverSources = packages.flatMap((pkg) =>
  walk(join(pkg, 'src'), (name) => name.endsWith('.ts') && !name.endsWith('.d.ts')),
);
const webSources = packages.flatMap((pkg) => walk(join(pkg, 'web', 'src'), (name) => /\.(ts|svelte)$/.test(name)));
const sources = [...serverSources, ...webSources];
const tests = packages.flatMap((pkg) => walk(join(pkg, 'test'), (name) => name.endsWith('.ts')));

// --- code, comments ----------------------------------------------------------
// The linter requires the same fifteen-line license header on every file. It says nothing about the
// code below it, so it is not counted as a comment. A Svelte <style> block is a stylesheet, and no
// budget counts stylesheets, so it is not counted as code.
const LICENSE_HEADER = /^\/\*\n \* Copyright \(c\) \d{4}, SimplySF\.[\s\S]*?\*\/\n/;

function countLines(text) {
  const body = text.replace(LICENSE_HEADER, '').replace(/<style[\s\S]*?<\/style>/g, '');
  let code = 0;
  let comments = 0;
  let inBlock = false;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      comments++;
      if (trimmed.includes('*/') || trimmed.includes('-->')) inBlock = false;
    } else if (trimmed.startsWith('/*') || trimmed.startsWith('<!--')) {
      comments++;
      inBlock = !(trimmed.includes('*/') || trimmed.includes('-->'));
    } else if (trimmed.startsWith('//')) {
      comments++;
    } else if (trimmed) {
      code++;
    }
  }
  return { code, comments };
}

const totals = sources.map((file) => countLines(read(file)));
const code = totals.reduce((n, t) => n + t.code, 0);
const comments = totals.reduce((n, t) => n + t.comments, 0);
const testLines = tests.reduce((n, file) => n + read(file).replace(LICENSE_HEADER, '').split('\n').length, 0);

// --- prose ---------------------------------------------------------------------
// Every Markdown file the project owns. The decision log, history and review are append-only, so
// they cannot be shortened and are not counted. The code of conduct is the Contributor Covenant,
// which the project adopted rather than wrote, so it is not counted either.
const docs = walk(root, (name) => name.endsWith('.md'))
  .map(rel)
  // test-env/.state holds what the end-to-end suite synced from Confluence, which is test data and
  // not the project's prose. The site's copies of the guides are generated from the package's docs/
  // on every build, so the guides are counted once, where they are written.
  .filter((file) => !/^(docs\/(history|review)\/|\.git\/|test-env\/\.state\/)/.test(file))
  .filter((file) => !/^site\/(dist\/|src\/content\/docs\/(getting-started\.md|guides\/))/.test(file))
  .filter((file) => file !== 'CODE_OF_CONDUCT.md' && file !== 'docs/decisions.md')
  .filter((file) => !file.includes('/node_modules/') && !file.includes('CHANGELOG.md'));
// The user guides ship inside each package and are read by people using the app, not by people
// working on it, so they are held to a budget of their own.
const isGuide = (file) => /^packages\/[^/]+\/docs\//.test(file);
const lines = (files) => files.reduce((n, file) => n + read(join(root, file)).split('\n').length, 0);
const docLines = lines(docs.filter((file) => !isGuide(file)));
const guideLines = lines(docs.filter(isGuide));

// --- dependencies --------------------------------------------------------------
// A dependency is not bad in itself, but each one is code the project trusts without writing, so
// adding one is a decision a person makes. Workspace packages are the project's own and are not
// counted.
const manifests = [join(root, 'package.json'), ...packages.map((pkg) => join(pkg, 'package.json'))];
const own = new Set(manifests.map((file) => JSON.parse(read(file)).name));
let runtimeDeps = 0;
let devDeps = 0;
for (const file of manifests) {
  const manifest = JSON.parse(read(file));
  runtimeDeps += Object.keys(manifest.dependencies ?? {}).filter((name) => !own.has(name)).length;
  devDeps += Object.keys(manifest.devDependencies ?? {}).filter((name) => !own.has(name)).length;
}
// The documentation site is a workspace of its own and is never published, so its dependencies are
// counted apart from the app's.
const siteManifest = JSON.parse(read(join(root, 'site/package.json')));
const siteDeps = ['dependencies', 'devDependencies'].reduce(
  (n, field) => n + Object.keys(siteManifest[field] ?? {}).length,
  0,
);

// --- who talks to Confluence, who runs programs, where pages go ----------------
// The question "what does this program send to Confluence?" should be answered by reading one file.
// This row counts the modules that import the library's clients or call fetch themselves.
const importsFrom = (text, module) =>
  [...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g)]
    .filter((match) => match[2] === module)
    .flatMap((match) => match[1].split(',').map((name) => name.trim()));
const matching = (files, test) => files.filter((file) => test(read(file))).map(rel);

const httpModules = matching(
  serverSources,
  (text) =>
    importsFrom(text, '@simplysf/simply-atlassian-core').some((name) =>
      /^(ConfluenceClient|HttpTransport)\b/.test(name),
    ) || /[^\w.]fetch\(/.test(text),
);
const execModules = matching(serverSources, (text) => /from '(node:)?child_process'/.test(text));
const aiSdkModules = matching(serverSources, (text) => /from '(@anthropic-ai\/sdk|openai|@google\/genai)/.test(text));
// Only the engine may import the code that sends to an AI, because the engine is where the outbound
// guard runs. The GuardedPayload type enforces the rest at compile time.
const aiSenderImporters = matching(serverSources, (text) => /from '[^']*\/(providers|geminiService)\.js'/.test(text));

// --- the artifact ----------------------------------------------------------------
// The bundle is measured on the built app that ships. CI builds before it tests. In a checkout that
// has not been built, this row is reported as not measured instead of passing silently.
const bundleFiles = packages.flatMap((pkg) => walk(join(pkg, 'dist', 'web', 'assets'), () => true));
const bundle = bundleFiles.length ? bundleFiles.reduce((n, file) => n + statSync(file).size, 0) : undefined;

const rows = [
  { name: 'MAX_CODE_LINES', label: 'code', value: code, limit: MAX_CODE_LINES, unit: 'lines' },
  {
    name: 'MAX_COMMENT_RATIO',
    label: 'comments',
    value: code ? Math.floor((comments * 100) / code) : 0,
    limit: MAX_COMMENT_RATIO,
    unit: `% of code (${comments} lines)`,
    advice: 'remove a comment that restates the code; this limit is never raised',
  },
  {
    name: 'MIN_TEST_RATIO',
    label: 'tests',
    value: testLines,
    limit: Math.ceil(code / MIN_TEST_RATIO),
    floor: true,
    unit: `lines (floor: 1 per ${MIN_TEST_RATIO} of code)`,
    advice: 'add tests for the code that has none',
  },
  {
    name: 'MAX_DOC_LINES',
    label: 'prose',
    value: docLines,
    limit: MAX_DOC_LINES,
    unit: 'lines',
    advice: 'shorten a document or retire one to docs/history/ instead of raising the limit',
  },
  {
    name: 'MAX_GUIDE_LINES',
    label: 'guides',
    value: guideLines,
    limit: MAX_GUIDE_LINES,
    unit: 'lines',
    advice: 'shorten a guide, or split what is reference into the package README, instead of raising the limit',
  },
  {
    name: 'MAX_SITE_DEPS',
    label: 'site deps',
    value: siteDeps,
    limit: MAX_SITE_DEPS,
    advice: 'write a decision record that argues for the dependency first',
  },
  {
    name: 'MAX_RUNTIME_DEPS',
    label: 'runtime deps',
    value: runtimeDeps,
    limit: MAX_RUNTIME_DEPS,
    advice: 'write a decision record that argues for the dependency first',
  },
  {
    name: 'MAX_DEV_DEPS',
    label: 'dev deps',
    value: devDeps,
    limit: MAX_DEV_DEPS,
    advice: 'write a decision record that argues for the dependency first',
  },
  {
    name: 'MAX_CONFLUENCE_HTTP_MODULES',
    label: 'http modules',
    value: httpModules.length,
    limit: MAX_CONFLUENCE_HTTP_MODULES,
    files: httpModules,
  },
  {
    name: 'MAX_EXEC_MODULES',
    label: 'exec modules',
    value: execModules.length,
    limit: MAX_EXEC_MODULES,
    files: execModules,
  },
  {
    name: 'MAX_AI_SDK_MODULES',
    label: 'ai sdk modules',
    value: aiSdkModules.length,
    limit: MAX_AI_SDK_MODULES,
    files: aiSdkModules,
  },
  {
    name: 'MAX_AI_SENDER_IMPORTERS',
    label: 'ai senders',
    value: aiSenderImporters.length,
    limit: MAX_AI_SENDER_IMPORTERS,
    unit: 'importer(s)',
    files: aiSenderImporters,
  },
  {
    name: 'MAX_BUNDLE_BYTES',
    label: 'bundle',
    value: bundle,
    limit: MAX_BUNDLE_BYTES,
    unit: 'bytes',
    unmeasured: bundle === undefined ? 'dist/web/assets is missing; run `pnpm run build` first' : undefined,
  },
].map((row) => ({
  ...row,
  ok: row.unmeasured ? undefined : row.floor ? row.value >= row.limit : row.value <= row.limit,
}));

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(rows));
} else {
  for (const row of rows) {
    const shown = row.unmeasured ? `not measured: ${row.unmeasured}` : `${row.value} ${row.unit ?? ''}`.trim();
    console.log(`${`${row.label}:`.padEnd(16)}${shown} (${row.floor ? 'floor' : 'budget'} ${row.limit})`);
    if (row.ok === false) {
      console.log(`\n  ${row.name} is ${row.floor ? 'under' : 'over'} budget${row.advice ? ` -- ${row.advice}` : ''}.`);
      for (const file of row.files ?? []) console.log(`    ${file}`);
      console.log('');
    }
  }
  if (rows.some((row) => row.ok !== true)) {
    console.log('\nTo change a limit, write a decision record that argues for the new number.');
    process.exitCode = 1;
  }
}
