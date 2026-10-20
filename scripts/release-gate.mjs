#!/usr/bin/env node
/**
 * Decides whether a stable version may be published. ADR-044 requires a second person to approve the
 * pull request that releases it, and this script is the command that enforces it: the release
 * workflow runs it before tagging or publishing a stable version, and a non-zero exit stops the
 * release.
 *
 * Usage:
 *   node scripts/release-gate.mjs check <version> <commit>   (needs GH_TOKEN and GITHUB_REPOSITORY)
 *   node scripts/release-gate.mjs body <version> <commit>    (prints the release pull request's text)
 *
 * The release pull request walks its reviewer through each load-bearing surface in the table in
 * AGENTS.md. The table and REVIEW_GUIDE below are checked against each other by the tests, so a
 * surface added to the table needs a guide entry before the suite passes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = /^\d+\.\d+\.\d+$/;

/** The lines of the load-bearing surfaces table in AGENTS.md, header included. */
function surfaceTable(agents) {
  const lines = agents.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === '### Load-bearing surfaces');
  if (start === -1) return [];
  const table = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    if (line.startsWith('|')) table.push(line);
  }
  return table;
}

/**
 * The rows of the load-bearing surfaces table in AGENTS.md.
 *
 * @param {string} agents The text of AGENTS.md.
 * @returns {{ surface: string, where: string }[]} One entry per table row, in table order.
 */
export function surfacesOf(agents) {
  return surfaceTable(agents)
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter(([, name]) => name !== 'surface' && !/^-+$/.test(name))
    .map(([, surface, where]) => ({ surface, where }));
}

const SRC = 'packages/simply-confluence-explorer/src';

/**
 * What the reviewer of a release reads, one entry per load-bearing surface in AGENTS.md, in table
 * order. `read` names the code to open, as a file and optionally the declaration to jump to, and
 * `check` says in plain words what has to hold there. The release pull request is the only review a
 * stable release gets (ADR-044), so this is written for someone who has never seen the project.
 * test/releaseGate.test.ts checks that every surface has an entry, that every file AGENTS.md names
 * for a surface is linked here, and that every file and declaration exists.
 */
export const REVIEW_GUIDE = [
  {
    surface: 'Writes to Confluence',
    about: 'The only code that changes Confluence.',
    items: [
      {
        file: `${SRC}/confluence/pagePush.ts`,
        symbol: 'writePage',
        check:
          "Refuses to write when the page changed in Confluence after the user started editing, so nobody's newer edit is lost. Refuses when converting the page from Markdown would drop images, macros, links, mentions or task lists. A dry run writes nothing.",
      },
      {
        file: `${SRC}/branches/branchRuns.ts`,
        check: 'When the AI proposes edits across a set of pages, only the pages the user accepted are written.',
      },
      {
        file: `${SRC}/drafts/drafts.ts`,
        check: 'A new page is created only after the user confirms it, and never with a title already in use.',
      },
    ],
  },
  {
    surface: 'HTTP to Confluence',
    about: 'The only module that talks to Confluence.',
    items: [
      {
        file: `${SRC}/confluence/client.ts`,
        check: 'The server it calls comes from the saved connection, and a request from the browser cannot choose it.',
      },
    ],
  },
  {
    surface: 'HTTP to GitLab',
    about: 'The only module that talks to GitLab, to read a repository for a new page.',
    items: [
      {
        file: `${SRC}/gitlab/client.ts`,
        symbol: 'parseRepoLink',
        check:
          'A link on any host other than the configured GitLab is refused, so a request cannot choose where the server fetches from.',
      },
      {
        file: `${SRC}/gitlab/client.ts`,
        symbol: 'GitLabClient',
        check: 'Only the README, docs, API files and manifest are read, within the file and character limits.',
      },
    ],
  },
  {
    surface: 'Tokens',
    about: "The user's Confluence and GitLab tokens.",
    items: [
      {
        file: `${SRC}/confluence/connection.ts`,
        symbol: 'publicView',
        check: '`publicView` is all the browser ever gets, and it must not include the token.',
      },
      {
        file: `${SRC}/gitlab/client.ts`,
        symbol: 'GitLabStore',
        check: 'The GitLab token is never in `publicView`, and a new address without a new token drops the old one.',
      },
      {
        file: `${SRC}/util/privateFile.ts`,
        symbol: 'writePrivateJson',
        check: 'The token is saved to a file only the user can read (mode 0600).',
      },
    ],
  },
  {
    surface: 'Pages sent to AI providers',
    about: 'The only code that sends anything to Claude, ChatGPT or Gemini.',
    items: [
      {
        file: `${SRC}/ai/providers.ts`,
        symbol: 'complete',
        check:
          'It accepts only a `GuardedPayload`, the type the outbound guard produces, so unchecked text cannot be sent.',
      },
      {
        file: `${SRC}/ai/providers.ts`,
        symbol: 'embed',
        check:
          'Sends section text for embeddings, again only as a `GuardedPayload`, and only to OpenAI or Gemini as Search by meaning chooses; Claude and the Gemini CLI offer none, and with it off nothing is sent.',
      },
      {
        file: `${SRC}/spaces/indexPacks.ts`,
        symbol: 'generateMetadataPack',
        check:
          'Sends several pages per indexing request, only pages the index run was given, which never include an excluded page, and through the engine and its guard. A page missing from the reply is retried alone, then recorded as failed.',
      },
      {
        file: `${SRC}/branches/corpusReview.ts`,
        symbol: 'CorpusReviews',
        check:
          'A review of more pages than one request carries sends each batch only after `contextCollector` has left out excluded pages and pages holding a secret. A stopped run writes nothing.',
      },
      {
        file: `${SRC}/branches/corpusReview.ts`,
        symbol: 'startAnswer',
        check:
          "A thorough answer reads each batch of sections through `readBatch`, which leaves out a page holding a secret, and sends the batches' notes through the guard again when it combines them.",
      },
    ],
  },
  {
    surface: 'The outbound guard',
    about: 'Checks everything before it goes to an AI.',
    items: [
      {
        file: `${SRC}/ai/guard.ts`,
        check:
          'Secrets such as keys and passwords stop the request; personal data such as email addresses and card numbers is replaced with placeholders.',
      },
      {
        file: `${SRC}/ai/guard.ts`,
        symbol: 'inspectTexts',
        check: 'For embeddings, a text holding a secret is not sent at all, and personal data is replaced.',
      },
      {
        file: `${SRC}/ai/engine.ts`,
        check:
          'Runs the guard on every question and every embedding request, and records each in the audit log. No path to an AI skips it.',
      },
      {
        file: `${SRC}/ai/manifest.ts`,
        symbol: 'checkPayload',
        check:
          'Every piece of context a request was built to carry must be in the guarded payload whole, or the engine refuses to send it. An excluded page is counted in the manifest, never named.',
      },
    ],
  },
  {
    surface: 'AI conversations and uploads',
    about: 'Saved chats, and the files a user attaches to them.',
    items: [
      {
        file: `${SRC}/ai/sessions.ts`,
        symbol: 'FILE_BYTE_LIMIT',
        check: 'An attached file is refused above the size limit, before its text is read.',
      },
      {
        file: `${SRC}/routes/sessions.ts`,
        check:
          'Each question, with the conversation so far and its attached files, goes to the AI only through `ai.chat`, which runs the guard.',
      },
    ],
  },
  {
    surface: 'AI keys',
    about: "The user's API keys for the AI providers.",
    items: [
      {
        file: `${SRC}/ai/settings.ts`,
        symbol: 'publicView',
        check: '`publicView` tells the browser only whether a key is set, never the key itself.',
      },
    ],
  },
  {
    surface: 'Telemetry kept on disk',
    about: "The app's own traces, logs and health numbers, kept in the data folder and shown on the Observability page.",
    items: [
      {
        file: `${SRC}/telemetry/telemetry.ts`,
        symbol: 'Telemetry',
        check:
          'Records counts, ids, durations, titles of allowed pages and error messages, never page text, prompts, answers, credentials or the title of an excluded page. Keeps 14 days, up to 200 MB.',
      },
      {
        file: `${SRC}/routes/observe.ts`,
        check: 'Only reads what was recorded, and a trace id from the request is validated before it is used.',
      },
    ],
  },
  {
    surface: 'External processes',
    about: 'The only program the app starts, the Gemini command-line tool.',
    items: [
      {
        file: `${SRC}/ai/geminiService.ts`,
        symbol: 'runGeminiCli',
        check: 'Runs without a shell, with fixed arguments; the page text goes in on standard input.',
      },
    ],
  },
  {
    surface: 'Deletes files',
    about: "Removes pages from the copy of a space kept on the user's disk.",
    items: [
      { file: `${SRC}/spaces/spaceStore.ts`, symbol: 'purgePage', check: 'Deletes only the pages asked for.' },
      {
        file: `${SRC}/spaces/spaceStore.ts`,
        symbol: 'removePage',
        check:
          "Every path it deletes, including the page's AI index entry and embeddings, is inside that space's folder.",
      },
    ],
  },
  {
    surface: 'Paths built from request values',
    about: 'File paths made from what a browser sends.',
    items: [
      { file: `${SRC}/http/guards.ts`, check: 'Space keys and page IDs are validated before they are used.' },
      {
        file: `${SRC}/util/paths.ts`,
        symbol: 'within',
        check: "Refuses any path that would land outside the app's data folder.",
      },
    ],
  },
  {
    surface: 'Sensitive-data exclusion',
    about: 'Users list pages in a `.confluenceignore` file to keep them away from any AI.',
    items: [
      {
        file: `${SRC}/spaces/exclusionManager.ts`,
        symbol: 'isPageExcluded',
        check: 'Applies those rules, to the page and to every page above it.',
      },
      {
        file: `${SRC}/spaces/aiGate.ts`,
        symbol: 'gatePageForAi',
        check: 'Refuses a page whenever it cannot confirm the page is allowed, rather than sending it.',
      },
      {
        file: `${SRC}/spaces/corpus.ts`,
        symbol: 'corpusPages',
        check:
          'Works out the pages a chat reads from on every turn, so a page excluded after it was chosen is no longer read.',
      },
      {
        file: `${SRC}/spaces/contextRetriever.ts`,
        check:
          'Sends a large chat only the sections it chose, and only their headings and summaries while choosing; a chat read in full goes through `contextCollector`, which leaves excluded pages out.',
      },
      { file: `${SRC}/routes/browse.ts`, check: 'Hides excluded pages from the page tree and refuses to serve them.' },
    ],
  },
  {
    surface: 'The enforcement itself',
    about: 'The checks that let a release out. Weakening one switches off the others above.',
    items: [
      {
        file: '.github/workflows/release.yml',
        check: 'Publishes a stable version only after `scripts/release-gate.mjs check` passes.',
      },
      {
        file: 'scripts/release-gate.mjs',
        symbol: 'approvalProblems',
        check:
          'Refuses a release unless someone other than its author approved the last commit of its pull request, or, below 1.0.0, a maintainer merged it (ADR-053).',
      },
      {
        file: 'packages/simply-confluence-explorer/test/budgets.test.ts',
        check: "Keeps the project's size limits, such as the number of dependencies, from being raised quietly.",
      },
      {
        file: 'packages/simply-confluence-explorer/package.json',
        check: 'The build and test scripts run what they claim to.',
      },
    ],
  },
];

/**
 * The line a declaration starts on, so a link can open the file at it.
 *
 * @param {string} text The file's text.
 * @param {string} symbol A function, method, class or constant declared in it.
 * @returns {number | undefined} The 1-based line, or undefined when it is not declared there.
 */
export function lineOf(text, symbol) {
  const declaration = new RegExp(`\\b(function|class|const|public|private)\\s+${symbol}\\b`);
  const index = text.split('\n').findIndex((line) => declaration.test(line));
  return index === -1 ? undefined : index + 1;
}

/**
 * The description of the pull request that releases a version. It is written for a reviewer who has
 * never seen the project: what the app is, why their approval matters, and a link to each piece of
 * code to read with what to check there.
 *
 * @param {string} version The version being released, such as 1.0.0.
 * @param {{ repoUrl: string, commit: string, read: (file: string) => string }} source Where the
 *   links point, and how to read a file of the commit being released.
 * @returns {string} Markdown.
 */
export function pullRequestBody(version, source) {
  const link = (item) => {
    const line = item.symbol ? lineOf(source.read(item.file), item.symbol) : undefined;
    const name = item.file.replace(`${SRC}/`, '') + (item.symbol ? ` \`${item.symbol}\`` : '');
    return `[\`${name.replace(/`/g, '')}\`](${source.repoUrl}/blob/${source.commit}/${item.file}${line ? `#L${line}` : ''})`;
  };
  const areas = REVIEW_GUIDE.flatMap((area, i) => [
    `${i + 1}. **${area.surface}.** ${area.about}`,
    ...area.items.map((item) => `   - ${link(item)}: ${item.check}`),
  ]);
  return [
    '## What this is',
    '',
    '**Confluence Explorer** is a small web app that runs on your own computer. It connects to a',
    "company's Confluence Server or Data Center with the user's personal token. With it you can browse",
    'a space, keep a copy of the space on disk, ask an AI about the pages, and have the AI suggest edits,',
    `which the user can write back to Confluence. The [README](${source.repoUrl}#readme) has screenshots`,
    'and the full feature list.',
    '',
    `This pull request releases **${version}**. It changes only the version number and the changelog;`,
    'what you are approving is the code already on `main`. Once it is merged, the release workflow tags',
    `${version} and publishes it to npm, so \`npx @simplysf/simply-confluence-explorer\` installs it.`,
    '',
    '## Why you are reviewing it',
    '',
    'The app can change Confluence pages that other people read, and it holds Confluence tokens and AI',
    'keys. So a stable release ships only after someone other than its author has read the code that',
    'carries that risk. **Your approval of this pull request is that review**, and from 1.0.0 the release',
    'workflow will not publish without it. Before 1.0.0, a maintainer may also merge it without an',
    'approval (ADR-053).',
    '',
    '## What to review',
    '',
    'There is no need to read the whole app. These are the areas where a mistake would leak data, change',
    'Confluence without the user agreeing, or switch off a safeguard. Each link opens the code being',
    'released, and says what has to hold there.',
    '',
    ...areas,
    '',
    '## When you are done',
    '',
    '- If it looks right, **approve** this pull request.',
    "- If something needs fixing, **request changes** and say what. The release won't publish while a",
    '  request for changes is open.',
    '- An approval covers the commit it was given on. If anything is pushed after it, approve again.',
  ].join('\n');
}

/**
 * What stops a merged release pull request from publishing its version.
 *
 * @param {string} version The version about to be published.
 * @param {object} pull The pull request, as GitHub's REST API returns it.
 * @param {object[]} reviews Its reviews, oldest first.
 * @param {string[]} maintainers GitHub logins that may release alone below 1.0.0 (ADR-053).
 * @returns {string[]} One sentence per problem; empty when the release may go ahead.
 */
export function approvalProblems(version, pull, reviews, maintainers = []) {
  if (!VERSION.test(version)) return [`"${version}" is not a stable version such as 1.0.0`];
  const problems = [];
  if (pull.head.ref !== `release/${version}`)
    problems.push(`pull request #${pull.number} is not from release/${version}`);
  // A reviewer's latest decision is the one that counts; a comment does not change it.
  const latest = new Map();
  for (const review of reviews) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review);
  }
  const decisions = [...latest.values()];
  const approved = decisions.some(
    (r) => r.state === 'APPROVED' && r.user.login !== pull.user.login && r.commit_id === pull.head.sha,
  );
  // Before the first major version, a maintainer's merge stands in for a second approval (ADR-053).
  const byMaintainer = version.startsWith('0.') && maintainers.includes(pull.merged_by?.login ?? '');
  if (!approved && !byMaintainer) {
    problems.push(`pull request #${pull.number} has no approval of its last commit from anyone but its author`);
  }
  for (const r of decisions.filter((r) => r.state === 'CHANGES_REQUESTED')) {
    problems.push(`${r.user.login} requested changes on pull request #${pull.number}`);
  }
  return problems;
}

/**
 * Finds the release pull request merged as `commit` and checks its approval.
 *
 * @param {string} version The version about to be published.
 * @param {string} commit The commit on main that holds the version.
 * @param {{ repo: string, token: string, fetch: typeof fetch, maintainers?: string[] }} github Where to ask,
 *   how, and who may release alone below 1.0.0.
 * @returns {Promise<string[]>} The problems found; empty when the release may go ahead.
 */
export async function releaseProblems(version, commit, github) {
  if (!VERSION.test(version)) return [`"${version}" is not a stable version such as 1.0.0`];
  const get = async (path) => {
    const response = await github.fetch(`https://api.github.com/repos/${github.repo}/${path}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${github.token}` },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
    return response.json();
  };
  const pulls = await get(`commits/${commit}/pulls`);
  const found = pulls.find((p) => p.merged_at && p.base.ref === 'main' && p.head.ref === `release/${version}`);
  if (!found) return [`${commit} is not the merge of a pull request from release/${version} into main`];
  // The list above leaves out who merged it, which only the pull request itself says.
  const pull = await get(`pulls/${found.number}`);
  const reviews = [];
  for (let page = 1; ; page++) {
    const batch = await get(`pulls/${pull.number}/reviews?per_page=100&page=${page}`);
    reviews.push(...batch);
    if (batch.length < 100) break;
  }
  return approvalProblems(version, pull, reviews, github.maintainers);
}

/**
 * The maintainers named in the `RELEASE_MAINTAINERS` repository variable, which the workflow passes in.
 *
 * @param {string | undefined} value A comma- or space-separated list of GitHub logins.
 * @returns {string[]} The logins.
 */
export function maintainersFrom(value) {
  return (value ?? '').split(/[\s,]+/).filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, version = '', commit = ''] = process.argv.slice(2);
  if (command === 'body') {
    const root = new URL('..', import.meta.url);
    const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY ?? 'SimplySF/simply-confluence-explorer'}`;
    const read = (file) => readFileSync(new URL(file, root), 'utf8');
    console.log(pullRequestBody(version, { repoUrl, commit, read }));
  } else if (command === 'check') {
    const github = {
      repo: process.env.GITHUB_REPOSITORY ?? '',
      token: process.env.GH_TOKEN ?? '',
      fetch,
      maintainers: maintainersFrom(process.env.RELEASE_MAINTAINERS),
    };
    const problems = await releaseProblems(version, commit, github);
    for (const problem of problems) console.error(`release gate: ${problem}`);
    if (problems.length > 0) {
      console.error(`release gate: ${version} may not be published as a stable release (ADR-044, ADR-053)`);
      process.exitCode = 1;
    } else {
      console.log(`release gate: ${version} was approved by a second person, or merged by a maintainer before 1.0`);
    }
  } else {
    console.error('usage: release-gate.mjs check <version> <commit> | body <version> <commit>');
    process.exitCode = 2;
  }
}
