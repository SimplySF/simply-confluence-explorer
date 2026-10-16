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

// The gate a stable release must pass: a second person has answered the review packet for every
// load-bearing surface (ADR-001, ADR-039).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { packetProblems, releaseProblems, surfacesOf } from '../../../scripts/release-gate.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const agents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
const template = fs.readFileSync(path.join(repoRoot, 'docs/review/TEMPLATE.md'), 'utf8');
const surfaces = surfacesOf(agents);

/** A packet that passes, with every surface answered. */
function answered(): string {
  return [
    '# Review packet for 1.0.0',
    '**Status:** answered',
    '**Second reviewer:** a reviewer',
    ...surfaces.flatMap((s) => [`### ${s}`, '', `**Answer:** read ${s}; it holds.`, '']),
  ].join('\n');
}

describe('the surfaces the gate asks about', () => {
  it('are the rows of the load-bearing surfaces table in AGENTS.md', () => {
    expect(surfaces).toContain('Writes to Confluence');
    expect(surfaces).toContain('The enforcement itself');
    expect(surfaces).not.toContain('surface');
  });

  it("are the template's headings, so a copied template asks every question the gate checks", () => {
    const headings = [...template.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(surfaces);
  });
});

describe('a review packet', () => {
  it('allows the release when it is answered for every surface', () => {
    expect(packetProblems(answered(), surfaces)).toEqual([]);
  });

  it('allows the release when the packet was checked out with Windows line endings', () => {
    expect(packetProblems(answered().replace(/\n/g, '\r\n'), surfaces)).toEqual([]);
  });

  it('stops the release while its status is still draft', () => {
    const packet = answered().replace('**Status:** answered', '**Status:** draft');
    expect(packetProblems(packet, surfaces)).toEqual(['the packet\'s status is not "answered"']);
  });

  it('stops the release when it names no second reviewer', () => {
    const packet = answered().replace('**Second reviewer:** a reviewer', '**Second reviewer:** <name>');
    expect(packetProblems(packet, surfaces)).toEqual(['the packet does not name its second reviewer']);
  });

  it('stops the release when one surface is left unanswered', () => {
    const packet = answered().replace('**Answer:** read Tokens; it holds.', '**Answer:** _unanswered_');
    expect(packetProblems(packet, surfaces)).toEqual(['"Tokens" has no answer']);
  });

  it('stops the release when a surface is missing from the packet altogether', () => {
    const packet = answered().replace('### Deletes files', '### Something else');
    expect(packetProblems(packet, surfaces)).toEqual(['"Deletes files" has no answer']);
  });

  it('stops the release when it is the template, unfilled', () => {
    expect(packetProblems(template, surfaces)).toHaveLength(2 + surfaces.length);
  });

  it('stops the release when no surfaces could be read from AGENTS.md', () => {
    expect(packetProblems(answered(), [])).toEqual(['no load-bearing surfaces were found in AGENTS.md']);
  });
});

describe('the gate for a version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
  fs.mkdirSync(path.join(root, 'docs/review'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), agents);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('stops a version that has no packet', () => {
    expect(releaseProblems('1.0.0', root)).toEqual(['there is no review packet at docs/review/1.0.0.md']);
  });

  it('allows a version whose packet is answered', () => {
    fs.writeFileSync(path.join(root, 'docs/review/1.1.0.md'), answered());
    expect(releaseProblems('1.1.0', root)).toEqual([]);
  });

  it('refuses a version that is not a plain stable version, even when a packet answers it', () => {
    fs.writeFileSync(path.join(root, 'docs/review/1.1.0-beta.0.md'), answered());
    expect(releaseProblems('1.1.0-beta.0', root)).toEqual(['"1.1.0-beta.0" is not a stable version such as 1.0.0']);
  });

  it('never reads a packet from outside docs/review, whatever the version names', () => {
    fs.writeFileSync(path.join(root, 'docs/1.1.0.md'), answered());
    expect(releaseProblems('../1.1.0', root)).toEqual(['"../1.1.0" is not a stable version such as 1.0.0']);
  });

  it('is unanswered for every version today, so no stable release can ship yet', () => {
    expect(releaseProblems('0.1.0', repoRoot)).not.toEqual([]);
  });
});
