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

// Which pages a space's .confluenceignore keeps away from an AI (ADR-018). These rules protect
// sensitive pages, so every way of failing must fail closed: hiding too much, never too little.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExclusionManager, matchesPattern } from '../src/spaces/exclusionManager.js';

const manager = (): { exclusions: ExclusionManager; dataDir: string; logged: string[] } => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-excl-'));
  const logged: string[] = [];
  return { exclusions: new ExclusionManager(dataDir, (m) => logged.push(m)), dataDir, logged };
};

describe('a rule', () => {
  it('matches a title, a title pattern, or a path and everything below it, ignoring case', () => {
    expect(matchesPattern('*Security*', 'HR Security Architecture')).toBe(true);
    expect(matchesPattern('*Security*', 'Normal Documentation')).toBe(false);
    expect(matchesPattern('SecretDir/', 'SecretDir/Nested Page')).toBe(true);
    expect(matchesPattern('SecretDir/', 'OtherDir/Nested Page')).toBe(false);
    expect(matchesPattern('salary bands', 'Salary Bands')).toBe(true);
  });

  it('treats a rule that is not a valid pattern as plain text instead of failing', () => {
    expect(matchesPattern('Why??', 'FAQ: Why?? and how')).toBe(true);
  });

  // Known defect, deferred to the maintainer (ADR-013): a rule matches anywhere in a title.
  it('also matches a title that only contains the rule, which over-excludes', () => {
    expect(matchesPattern('Restricted/', 'Unrestricted Access Guide')).toBe(true);
  });
});

describe('a space', () => {
  it('excludes a page by id, by title, by an ancestor, and by its path', () => {
    const { exclusions } = manager();
    exclusions.savePatterns('HR', ['id:1001', 'Salary Bands', 'Interviews/Internal/']);
    expect(exclusions.isPageExcluded({ id: '1001', title: 'Anything' }, 'HR')).toBe(true);
    expect(exclusions.isPageExcluded({ id: '2', title: 'Salary Bands' }, 'hr')).toBe(true);
    expect(
      exclusions.isPageExcluded(
        { id: '3', title: 'Feedback', ancestors: [{ title: 'Interviews' }, { title: 'Internal' }] },
        'HR',
      ),
    ).toBe(true);
    expect(
      exclusions.isPageExcluded({ id: '4', title: 'Interview Guide', ancestors: [{ title: 'Interviews' }] }, 'HR'),
    ).toBe(false);
  });

  it('excludes everything below a page excluded by its id, not only the page itself', () => {
    const { exclusions } = manager();
    exclusions.savePatterns('HR', ['id:500']);
    expect(
      exclusions.isPageExcluded({ id: '501', title: 'Child', ancestors: [{ id: '500', title: 'Parent' }] }, 'HR'),
    ).toBe(true);
    expect(
      exclusions.isPageExcluded({ id: '502', title: 'Sibling', ancestors: [{ id: '499', title: 'Other' }] }, 'HR'),
    ).toBe(false);
  });

  it('excludes nothing when it has no rules file', () => {
    expect(manager().exclusions.isPageExcluded({ id: '1', title: 'Anything' }, 'OPS')).toBe(false);
  });

  it('ignores comment lines, and reads a rule that was saved a moment ago', () => {
    const { exclusions } = manager();
    exclusions.savePatterns('OPS', ['# a comment', 'Deploy Notes']);
    expect(exclusions.patterns('OPS')).toEqual(['Deploy Notes']);
    exclusions.savePatterns('OPS', ['Team Contacts']);
    expect(exclusions.patterns('OPS')).toEqual(['Team Contacts']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'excludes every page when its rules file cannot be read, rather than none',
    () => {
      const { exclusions, logged } = manager();
      exclusions.savePatterns('HR', ['Secret']);
      const file = exclusions.ignoreFilePath('HR');
      fs.chmodSync(file, 0o000);
      try {
        expect(exclusions.isPageExcluded({ id: '1', title: 'Anything at all' }, 'HR')).toBe(true);
        expect(logged[0]).toMatch(/every page in HR is excluded/);
      } finally {
        fs.chmodSync(file, 0o600);
      }
    },
  );

  it('applies a changed rule at once, though a pass over the space has asked about every page before', () => {
    const { exclusions } = manager();
    exclusions.savePatterns('HR', ['Salary Bands']);
    const page = { id: '7', title: 'Interview Guide', ancestors: [{ id: '1', title: 'Hiring' }] };
    const first = exclusions.checker('HR');
    expect(first(page)).toBe(false);
    expect(first(page)).toBe(false);
    exclusions.savePatterns('HR', ['Salary Bands', 'Hiring/']);
    expect(exclusions.checker('HR')(page)).toBe(true);
    expect(exclusions.isPageExcluded(page, 'HR')).toBe(true);
    // A rule written to the file by hand, not through the app, applies too.
    fs.writeFileSync(exclusions.ignoreFilePath('HR'), 'Salary Bands\n');
    fs.utimesSync(exclusions.ignoreFilePath('HR'), new Date(), new Date(Date.now() + 5000));
    expect(exclusions.checker('HR')(page)).toBe(false);
  });

  it('gives a pass over the space the same answer for every page as checking each page alone', () => {
    const { exclusions } = manager();
    exclusions.savePatterns('HR', ['id:3', '*Secret*', 'Payroll/']);
    const pages = [
      { id: '1', title: 'Welcome' },
      { id: '3', title: 'Plain' },
      { id: '4', title: 'Top Secret Plans' },
      { id: '5', title: 'Run', ancestors: [{ id: '9', title: 'Payroll' }] },
      { id: '6', title: 'Child', ancestors: [{ id: '3', title: 'Plain' }] },
    ];
    const pass = exclusions.checker('HR');
    expect(pages.map((p) => pass(p))).toEqual(pages.map((p) => exclusions.isPageExcluded(p, 'HR')));
    expect(pages.map((p) => pass(p))).toEqual([false, true, true, true, true]);
  });

  it('keeps a space key of ".." inside the data directory', () => {
    const { exclusions, dataDir } = manager();
    expect(exclusions.ignoreFilePath('..')).toBe(path.join(dataDir, 'spaces', '_', '.confluenceignore'));
  });
});
