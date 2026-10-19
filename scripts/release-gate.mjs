#!/usr/bin/env node
/**
 * Decides whether a stable version may be published. ADR-044 requires a second person to approve the
 * pull request that releases it, and this script is the command that enforces it: the release
 * workflow runs it before tagging or publishing a stable version, and a non-zero exit stops the
 * release.
 *
 * Usage:
 *   node scripts/release-gate.mjs check <version> <commit>   (needs GH_TOKEN and GITHUB_REPOSITORY)
 *   node scripts/release-gate.mjs body <version>             (prints the release pull request's text)
 *
 * The list of load-bearing surfaces is read from the table in AGENTS.md rather than repeated here, so
 * a surface added to the table is one the next release pull request asks its reviewer about.
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
 * The surface names in the load-bearing surfaces table of AGENTS.md.
 *
 * @param {string} agents The text of AGENTS.md.
 * @returns {string[]} One name per table row, in table order.
 */
export function surfacesOf(agents) {
  return surfaceTable(agents)
    .map((line) => line.split('|').map((cell) => cell.trim())[1])
    .filter((name) => name !== 'surface' && !/^-+$/.test(name));
}

/**
 * The description of the pull request that releases a version, which tells its reviewer what
 * approving it means and where the risk is.
 *
 * @param {string} version The version being released, such as 1.0.0.
 * @param {string} agents The text of AGENTS.md.
 * @returns {string} Markdown.
 */
export function pullRequestBody(version, agents) {
  return [
    `This pull request releases ${version} of \`@simplysf/simply-confluence-explorer\`. It changes only`,
    'the version and the changelog; the code it releases is what is on `main` now.',
    '',
    'Approving it is the second-person review a stable release needs (ADR-044). The approval has to',
    'come from someone other than whoever opened it, and covers its last commit only. Merging it tags',
    `${version} and publishes it to npm as \`latest\`, which is what a plain \`npx\` installs.`,
    '',
    '## Where the risk is',
    '',
    'These are the load-bearing surfaces from `AGENTS.md`: the parts of the code where a mistake would',
    'leak data, change Confluence without consent, or switch off a safeguard. The paths are relative to',
    '`packages/simply-confluence-explorer/src/`.',
    '',
    ...surfaceTable(agents),
  ].join('\n');
}

/**
 * What stops a merged release pull request from publishing its version.
 *
 * @param {string} version The version about to be published.
 * @param {object} pull The pull request, as GitHub's REST API returns it.
 * @param {object[]} reviews Its reviews, oldest first.
 * @returns {string[]} One sentence per problem; empty when the release may go ahead.
 */
export function approvalProblems(version, pull, reviews) {
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
  if (!approved) {
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
 * @param {{ repo: string, token: string, fetch: typeof fetch }} github Where to ask, and how.
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
  const pull = pulls.find((p) => p.merged_at && p.base.ref === 'main' && p.head.ref === `release/${version}`);
  if (!pull) return [`${commit} is not the merge of a pull request from release/${version} into main`];
  const reviews = [];
  for (let page = 1; ; page++) {
    const batch = await get(`pulls/${pull.number}/reviews?per_page=100&page=${page}`);
    reviews.push(...batch);
    if (batch.length < 100) break;
  }
  return approvalProblems(version, pull, reviews);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, version = '', commit = ''] = process.argv.slice(2);
  const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  if (command === 'body') {
    console.log(pullRequestBody(version, agents));
  } else if (command === 'check') {
    const github = { repo: process.env.GITHUB_REPOSITORY ?? '', token: process.env.GH_TOKEN ?? '', fetch };
    const problems = await releaseProblems(version, commit, github);
    for (const problem of problems) console.error(`release gate: ${problem}`);
    if (problems.length > 0) {
      console.error(`release gate: ${version} may not be published as a stable release (ADR-044)`);
      process.exitCode = 1;
    } else {
      console.log(`release gate: ${version} was approved by a second person`);
    }
  } else {
    console.error('usage: release-gate.mjs check <version> <commit> | body <version>');
    process.exitCode = 2;
  }
}
