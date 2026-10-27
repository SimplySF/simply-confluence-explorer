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
import { ancestorsOf, collapsedFor, visibleRows, withChildren } from '../../web/src/support/tree.js';

const node = (id: string, children: PageTreeNode[] = []): PageTreeNode =>
  ({ id, title: id, children }) as unknown as PageTreeNode;

const tree = [
  node('eng', [node('atlas', [node('devops'), node('runbook')]), node('notes')]),
  node('ops', [node('oncall')]),
];

describe('the sidebar tree of a space that has just loaded', () => {
  it('starts collapsed, showing only the top-level pages', () => {
    expect([...collapsedFor(tree, 'eng')].sort()).toEqual(['atlas', 'eng', 'ops']);
  });

  it('keeps the way down to the selected page open', () => {
    expect([...collapsedFor(tree, 'devops')].sort()).toEqual(['ops']);
    expect(ancestorsOf(tree, 'devops')).toEqual(['eng', 'atlas']);
    expect(ancestorsOf(tree, 'missing')).toEqual([]);
  });
});

describe('the rows a tree shows', () => {
  it('hide what is under a folded page, and keep the way down to a page a filter matches', () => {
    const ids = (rows: ReturnType<typeof visibleRows>): string[] => rows.map((r) => r.node.id);
    expect(ids(visibleRows(tree, new Set(['atlas']), ''))).toEqual(['eng', 'atlas', 'notes', 'ops', 'oncall']);
    expect(ids(visibleRows(tree, new Set(), 'runbook'))).toEqual(['eng', 'atlas', 'runbook']);
    expect([...withChildren(tree)].sort()).toEqual(['atlas', 'eng', 'ops']);
  });
});
