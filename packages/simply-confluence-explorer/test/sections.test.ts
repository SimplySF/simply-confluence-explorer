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

// Splitting pages into the sections that retrieval searches and sends (ADR-051).

import { describe, expect, it } from 'vitest';
import { headingOf, SECTION_CHARS, sectionName, splitSections } from '../src/spaces/sections.js';

describe('splitting a page into sections', () => {
  it('splits at headings and keeps the headings above each section', () => {
    const md =
      '---\ntitle: Runbook\n---\n\nIntro text.\n\n# Deploy\n\nSteps.\n\n## Rollback\n\nUndo it.\n\n# Contacts\n\nOn call.';
    const sections = splitSections('7', md);
    expect(sections.map((s) => [s.index, s.path, s.text])).toEqual([
      [0, [], 'Intro text.'],
      [1, ['Deploy'], 'Steps.'],
      [2, ['Deploy', 'Rollback'], 'Undo it.'],
      [3, ['Contacts'], 'On call.'],
    ]);
    expect(sectionName('Runbook', sections[2])).toBe('Runbook › Deploy › Rollback');
  });

  it('makes no section of a heading with nothing under it before the next heading', () => {
    const sections = splitSections('7', '# Deploy\n\n## Steps\n\nRun it.');
    expect(sections.map((s) => s.path)).toEqual([['Deploy', 'Steps']]);
  });

  it('treats a heading inside a code block as text', () => {
    const sections = splitSections('7', '# Script\n\n```sh\n# not a heading\necho hi\n```');
    expect(sections).toHaveLength(1);
    expect(sections[0].text).toContain('# not a heading');
  });

  it('splits a long section at paragraph breaks, keeping its heading on every part', () => {
    const paragraph = 'word '.repeat(300).trim();
    const sections = splitSections('7', `# Long\n\n${[paragraph, paragraph, paragraph].join('\n\n')}`);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.text.length <= SECTION_CHARS && s.path[0] === 'Long')).toBe(true);
    expect(sections.map((s) => s.text).join('\n\n')).toBe([paragraph, paragraph, paragraph].join('\n\n'));
  });

  it('cuts a single paragraph that is longer than a section', () => {
    const sections = splitSections('7', 'x'.repeat(SECTION_CHARS * 2 + 10));
    expect(sections.map((s) => s.text.length)).toEqual([SECTION_CHARS, SECTION_CHARS, 10]);
  });
});

describe('naming a section', () => {
  it('leaves out a first heading that only repeats the page title', () => {
    const [intro, status] = splitSections('7', '# Architecture Overview\n\nWhat it is.\n\n## Status\n\nLive.');
    expect(headingOf('Architecture Overview', intro)).toBe('Introduction');
    expect(headingOf('Architecture Overview', status)).toBe('Status');
    expect(sectionName('Architecture Overview', status)).toBe('Architecture Overview › Status');
    expect(headingOf('Runbook', { path: ['Deploy'] })).toBe('Deploy');
  });
});
