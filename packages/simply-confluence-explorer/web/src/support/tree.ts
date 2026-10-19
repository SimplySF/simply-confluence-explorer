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

// Which pages of the sidebar tree start folded. A space opens with only its top-level pages showing,
// so a large space is readable at a glance, except that the way down to the page on screen stays open.

import type { PageTreeNode } from '../../../src/api/types.js';

/** The ids of the pages above `pageId`, from the top of the tree down, or `[]` when it is not in the tree. */
export function ancestorsOf(nodes: PageTreeNode[], pageId: string | null): string[] {
  for (const n of nodes) {
    if (n.id === pageId) return [];
    const below = ancestorsOf(n.children, pageId);
    if (below.length > 0 || n.children.some((c) => c.id === pageId)) return [n.id, ...below];
  }
  return [];
}

/**
 * Every page that has pages under it, except those on the way down to the selected page.
 *
 * @param nodes The tree.
 * @param selectedId The page on screen, which stays visible.
 */
export function collapsedFor(nodes: PageTreeNode[], selectedId: string | null): Set<string> {
  const open = new Set(ancestorsOf(nodes, selectedId));
  const folded = new Set<string>();
  const walk = (list: PageTreeNode[]): void => {
    for (const n of list) {
      if (n.children.length === 0) continue;
      if (!open.has(n.id)) folded.add(n.id);
      walk(n.children);
    }
  };
  walk(nodes);
  return folded;
}
