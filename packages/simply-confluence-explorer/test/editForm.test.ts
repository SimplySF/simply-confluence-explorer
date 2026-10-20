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

// A page is changed through its edit form: text with a marker for each part Markdown has no form for.
// Writing it back keeps every part exactly and every untouched block byte for byte, and refuses a
// change that would lose a part nobody accepted removing (ADR-058).

import { describe, expect, it } from 'vitest';
import { spaces, type DatasetPage } from '../../../test-env/fixtures/dataset.mjs';
import { buildStorage, toEditForm } from '../src/parser/editForm.js';

const bodies = new Map<string, string>();
const walk = (key: string, nodes: DatasetPage[] = []): void => {
  for (const node of nodes) {
    const body = typeof node.body === 'function' ? node.body({ userKey: 'admin-user-key' }) : node.body;
    if (body) bodies.set(`${key}/${node.title}`, body);
    walk(key, node.children);
  }
};
for (const space of spaces) {
  bodies.set(`${space.key}/home`, space.home);
  walk(space.key, space.pages);
}

const INCIDENT = bodies.get('PLAT/INC-1001: Gateway latency spike')!;
const TOC = '<ac:structured-macro ac:name="toc"></ac:structured-macro>';
const LAYOUT =
  '<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>Left side.</p></ac:layout-cell>' +
  '<ac:layout-cell><p>Right side.</p><p>More on the right.</p></ac:layout-cell></ac:layout-section></ac:layout>';

const refused = (storage: string, edit: (markdown: string) => string, removes?: number[]): string => {
  const form = toEditForm(storage);
  try {
    buildStorage(form, edit(form.markdown), removes);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the change was not refused');
};

describe('an unchanged edit form', () => {
  it('writes back every page in the test dataset exactly as Confluence holds it', () => {
    for (const [key, storage] of bodies) {
      const form = toEditForm(storage);
      expect(buildStorage(form, form.markdown), key).toBe(storage);
    }
  });

  it('stands in a marker for each part Markdown has no form for, keeping code and tables as text', () => {
    const form = toEditForm(bodies.get('PLAT/Architecture Overview')!);
    expect(form.parts.map((p) => `${p.n} ${p.label}`)).toEqual([
      '1 mention',
      '2 info: Heads up',
      '3 warning: Careful',
      '4 note',
      '5 tip: Pro tip',
      '6 panel: Generic panel',
      '7 code: server.ts',
      '8 noformat',
      '9 status: ACTIVE',
      '10 status: DEPRECATED',
      '11 status: BETA',
      '12 expand: Show legacy details',
      '13 excerpt',
      '14 jira: PLAT-123',
      '15 image: architecture-diagram.png',
      '16 link: Gateway Service',
      '17 link: On-Call Handbook',
    ]);
    expect(form.markdown).toContain('⟦2 info: Heads up⟧\n\nInfo panels become alerts.\n\n⟦/2⟧');
    expect(form.markdown).toContain('```python\ndef handler(event):');
    expect(form.markdown).toContain('| API Gateway | Platform | Go |');
  });
});

describe('a change', () => {
  it('rewrites only the block it changes, keeping the toc, the status and the task list', () => {
    const form = toEditForm(INCIDENT);
    const built = buildStorage(
      form,
      form.markdown.replace('| 09:00 | Alert fired |', '| 09:00 | Alert fired by the pager |'),
    );
    const table = (s: string): string => /<table>[\s\S]*<\/table>/.exec(s)![0];
    expect(built.replace(table(built), '')).toBe(INCIDENT.replace(table(INCIDENT), ''));
    expect(table(built)).toContain('Alert fired by the pager');
  });

  it('keeps a part it moves', () => {
    const form = toEditForm(INCIDENT);
    const moved = `${form.markdown.replace('⟦1 toc⟧\n\n', '')}\n\n⟦1 toc⟧`;
    const built = buildStorage(form, moved);
    expect(built.endsWith('<ac:structured-macro ac:name="toc"></ac:structured-macro>')).toBe(true);
    expect(built).toContain('<ac:parameter ac:name="title">SEV2</ac:parameter>');
  });

  it("edits a panel's text inside the panel, keeping the macro and its title", () => {
    const storage = bodies.get('PLAT/Architecture Overview')!;
    const form = toEditForm(storage);
    const built = buildStorage(
      form,
      form.markdown.replace('Do not deploy on Fridays.', 'Do not deploy after Thursday noon.'),
    );
    expect(built).toBe(
      storage.replace('<p>Do not deploy on Fridays.</p>', '<p>Do not deploy after Thursday noon.</p>'),
    );
  });

  it('edits the text of one column of a layout, keeping the layout', () => {
    const form = toEditForm(LAYOUT);
    expect(form.markdown).toBe(
      '⟦1 layout⟧\n\n⟦2 layout section: two equal⟧\n\n⟦3 column 1 of 2⟧\n\nLeft side.\n\n⟦/3⟧\n\n' +
        '⟦4 column 2 of 2⟧\n\nRight side.\n\nMore on the right.\n\n⟦/4⟧\n\n⟦/2⟧\n\n⟦/1⟧',
    );
    expect(buildStorage(form, form.markdown.replace('More on the right.', 'Even more.'))).toBe(
      LAYOUT.replace('More on the right.', 'Even more.'),
    );
  });

  it('keeps whole a block its text cannot carry, such as a table with merged cells', () => {
    const storage =
      '<table><tbody><tr><th>A</th><th>B</th></tr><tr><td colspan="2">wide</td></tr></tbody></table><p>After.</p>';
    const form = toEditForm(storage);
    expect(form.markdown).toBe('⟦1 table, kept as it is⟧\n\nAfter.');
    expect(buildStorage(form, '⟦1 table, kept as it is⟧\n\nAfter, edited.')).toBe(
      storage.replace('After.', 'After, edited.'),
    );
  });

  it('names the formatting a block holds that its text cannot, so a change to it can say so', () => {
    const form = toEditForm('<p>Plain.</p><p>Some <span style="color: red;">red</span> text.</p>');
    expect(form.units.map((u) => u.drops)).toEqual([[], ['text colour or highlighting']]);
  });
});

describe('a change is refused, and names why, when it', () => {
  it('drops a part nobody accepted removing', () => {
    expect(refused(INCIDENT, (md) => md.replace('⟦1 toc⟧\n\n', ''))).toBe(
      'This change would remove parts of the page that no accepted change removes: ⟦1 toc⟧. Nothing was written.',
    );
  });

  it('names a part the page does not have', () => {
    expect(refused(INCIDENT, (md) => `${md}\n\n⟦9 jira⟧`)).toContain('⟦9⟧ is not a part of this page');
  });

  it('uses a part twice', () => {
    expect(refused(INCIDENT, (md) => `${md}\n\n⟦1 toc⟧`)).toContain('⟦1 toc⟧ appears twice');
  });

  it("crosses a container's markers or keeps only one of them", () => {
    expect(refused(LAYOUT, (md) => md.replace('⟦/3⟧\n\n⟦4 column 2 of 2⟧', '⟦4 column 2 of 2⟧\n\n⟦/3⟧'))).toContain(
      'are not paired',
    );
    expect(refused(LAYOUT, (md) => md.replace('⟦/4⟧\n\n', ''))).toContain('are not paired');
  });

  it('puts a block part inside a line of text', () => {
    expect(refused(INCIDENT, (md) => md.replace('⟦1 toc⟧\n\n## Summary', '## Summary ⟦1 toc⟧'))).toContain(
      '⟦1 toc⟧ must be on a line of its own',
    );
  });

  it('puts a part inside code, where it would be only characters', () => {
    expect(
      refused(INCIDENT, (md) => md.replace('⟦3 task list: 2 tasks⟧', '```\n⟦3 task list: 2 tasks⟧\n```')),
    ).toContain('no accepted change removes: ⟦3 task list: 2 tasks⟧');
  });
});

describe('a part lost on the way', () => {
  it('is caught by comparing what would be written with the page, however it was lost', () => {
    const form = toEditForm(INCIDENT);
    const status = form.parts.find((p) => p.label === 'status: SEV2')!;
    // As if the part's storage had been lost while the edit form was built.
    (status as { xml: string }).xml = 'SEV2';
    expect(() => buildStorage(form, form.markdown.replace('Severity', 'Sev'))).toThrow(
      'This change would lose 1 "status" macro from the page. Nothing was written.',
    );
  });
});

describe('a removal a person accepted', () => {
  it('is written, and only the removed part is gone', () => {
    const form = toEditForm(`${TOC}<p>Text.</p>`);
    expect(buildStorage(form, 'Text.', [1])).toBe('<p>Text.</p>');
  });
});
