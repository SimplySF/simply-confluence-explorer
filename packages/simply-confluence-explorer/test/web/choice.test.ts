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

import { describe, expect, it } from 'vitest';
import type { PageTreeNode } from '../../src/api/types.js';
import { titleLeftOut as serverTitleLeftOut } from '../../src/spaces/corpus.js';
import { count, emptyChoice, marks, titleLeftOut, toggle, type Choice } from '../../web/src/support/choice.js';

const node = (id: string, title: string, children: PageTreeNode[] = []): PageTreeNode => ({
  id,
  title,
  spaceKey: 'PLAT',
  version: 1,
  author: 'a',
  lastModified: '',
  children,
});
// A directory with two sections, one of them CR templates, and a page beside it.
const tree = [
  node('dir', 'Processes', [
    node('a', 'Release Process', [node('a1', 'Hotfixes')]),
    node('t', 'CR Templates', [node('t1', 'CR Template: Database'), node('t2', 'CR Template: Network')]),
  ]),
  node('c', 'Contacts'),
];
const find = (id: string, list = tree): PageTreeNode =>
  list.find((n) => n.id === id) ??
  find(
    id,
    list.flatMap((n) => n.children),
  );
const tagged = new Set<string>();
const all = (c: Choice): ReturnType<typeof marks> => marks(tree, c, tagged);
const tick = (c: Choice, id: string, on: boolean): Choice => toggle(c, find(id), on, (next) => all(next).get(id)!.own);

describe('choosing pages from the tree', () => {
  it('leaves a sub-page out of a chosen directory, where a directory could only be taken whole', () => {
    let choice = tick(emptyChoice(), 'dir', true);
    expect(choice.dirs).toEqual(['dir']);
    expect(count(all(choice))).toEqual({ read: 6, leftOut: 0 });

    choice = tick(choice, 't', false);
    expect(choice.leftOut).toEqual(['t']);
    expect(all(choice).get('t1')!.own, 'left out with the page above it').toBe('left');
    expect(all(choice).get('dir')).toMatchObject({ own: 'in', mixed: true });
    expect(count(all(choice))).toEqual({ read: 3, leftOut: 3 });

    choice = tick(choice, 't', true);
    expect(choice).toMatchObject({ dirs: ['dir'], leftOut: [] });
    expect(all(choice).get('dir')!.mixed).toBe(false);
  });

  it('takes a page without sub-pages alone, and clears what was chosen under a page unticked', () => {
    let choice = tick(emptyChoice(), 'c', true);
    expect(choice.pageIds).toEqual(['c']);
    choice = tick(choice, 'a1', true);
    expect(all(choice).get('dir')).toMatchObject({ own: 'none', mixed: true });
    choice = tick(choice, 'dir', false);
    expect(choice).toMatchObject({ dirs: [], pageIds: ['c'], leftOut: [] });
  });

  it('leaves out every chosen page whose title holds a rule, as the server does', () => {
    const choice = { ...tick(emptyChoice(), 'dir', true), leaveOutTitles: ['cr template'] };
    expect(all(choice).get('t1')!.own).toBe('rule');
    expect(all(choice).get('t')!.own, 'the folder title holds it too').toBe('rule');
    expect(count(all(choice))).toEqual({ read: 3, leftOut: 3 });
    for (const title of ['CR Template: Database', 'Release Process', 'cr templates']) {
      expect(titleLeftOut(title, ['CR template']), title).toBe(serverTitleLeftOut(title, ['CR template']));
    }
  });
});
