#!/usr/bin/env node
/**
 * Decides whether a stable version may be published. ADR-001 requires a second person to answer the
 * review packet for every load-bearing surface before a release ships, and ADR-039 makes this script
 * the command that enforces it: the release workflow runs it before tagging a stable version, and a
 * non-zero exit stops the release.
 *
 * Usage: node scripts/release-gate.mjs <version>
 *
 * The packet is docs/review/<version>.md, laid out as docs/review/TEMPLATE.md. The list of surfaces
 * is read from the table in AGENTS.md rather than repeated here, so a surface added to the table is
 * one the next packet must answer.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = /^\d+\.\d+\.\d+$/;
const PLACEHOLDER = /^(_unanswered_|<.*>)?$/;

/**
 * The surface names in the load-bearing surfaces table of AGENTS.md.
 *
 * @param {string} agents The text of AGENTS.md.
 * @returns {string[]} One name per table row, in table order.
 */
export function surfacesOf(agents) {
  const lines = agents.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === '### Load-bearing surfaces');
  if (start === -1) return [];
  const surfaces = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 3 || cells[1] === 'surface' || /^-+$/.test(cells[1])) continue;
    surfaces.push(cells[1]);
  }
  return surfaces;
}

/**
 * What is missing from a review packet, measured against the surfaces it must answer.
 *
 * @param {string} packet The text of the review packet.
 * @param {string[]} surfaces The surfaces from AGENTS.md.
 * @returns {string[]} One sentence per problem; empty when the packet allows the release.
 */
export function packetProblems(packet, surfaces) {
  const text = packet.replace(/\r\n/g, '\n');
  const field = (name) => new RegExp(`^\\*\\*${name}:\\*\\*(.*)$`, 'm').exec(text)?.[1].trim() ?? '';
  const problems = [];
  if (field('Status') !== 'answered') problems.push('the packet\'s status is not "answered"');
  if (PLACEHOLDER.test(field('Second reviewer'))) problems.push('the packet does not name its second reviewer');
  if (surfaces.length === 0) problems.push('no load-bearing surfaces were found in AGENTS.md');
  for (const surface of surfaces) {
    const section = text.split(`\n### ${surface}\n`)[1]?.split('\n#')[0];
    const answer = section === undefined ? undefined : /^\*\*Answer:\*\*(.*)$/m.exec(section)?.[1].trim();
    if (answer === undefined || PLACEHOLDER.test(answer)) problems.push(`"${surface}" has no answer`);
  }
  return problems;
}

/**
 * Checks the packet for one version.
 *
 * @param {string} version The version about to be published, such as 1.0.0.
 * @param {string} root The repository root.
 * @returns {string[]} The problems found; empty when the release may go ahead.
 */
export function releaseProblems(version, root) {
  if (!VERSION.test(version)) return [`"${version}" is not a stable version such as 1.0.0`];
  const packetPath = `${root}/docs/review/${version}.md`;
  if (!existsSync(packetPath)) return [`there is no review packet at docs/review/${version}.md`];
  return packetProblems(readFileSync(packetPath, 'utf8'), surfacesOf(readFileSync(`${root}/AGENTS.md`, 'utf8')));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] ?? '';
  const problems = releaseProblems(version, fileURLToPath(new URL('..', import.meta.url)));
  for (const problem of problems) console.error(`release gate: ${problem}`);
  if (problems.length > 0) {
    console.error(`release gate: ${version} may not be published as a stable release (ADR-001, ADR-039)`);
    process.exitCode = 1;
  } else {
    console.log(`release gate: the review packet for ${version} is answered`);
  }
}
