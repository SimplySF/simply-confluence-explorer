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

// The pages a Space chat reads, as ticks on the space's tree (design doc 0016). A ticked page with
// pages under it is a directory, read with everything under it now and later; a page unticked inside
// one is left out with everything under it; a title rule leaves out any chosen page whose title holds
// its words. The server reads the same choice the same way (`corpusPages`).

import type { PageTreeNode } from '../../../src/api/types.js';

export type Choice = { dirs: string[]; pageIds: string[]; tags: string[]; leftOut: string[]; leaveOutTitles: string[] };

/** Whether a page is read (`in`), left out by a tick or with a page above it (`left`), left out by a title rule, or not chosen. */
export type Own = 'in' | 'left' | 'rule' | 'none';
/** A page's own state, and whether what is under it is read differently, shown as a part-ticked box. */
export type Mark = { own: Own; mixed: boolean; chosen: boolean };

export const emptyChoice = (): Choice => ({ dirs: [], pageIds: [], tags: [], leftOut: [], leaveOutTitles: [] });

/** Whether a title rule leaves a page out; the server asks the same (`titleLeftOut`). */
export const titleLeftOut = (title: string, rules: readonly string[]): boolean =>
  rules.some((rule) => title.toLowerCase().includes(rule.toLowerCase()));

/**
 * Every page's mark, in one pass over the tree.
 *
 * @param tree The space's pages.
 * @param choice What is chosen.
 * @param tagged The pages that carry a chosen tag.
 */
export function marks(tree: PageTreeNode[], choice: Choice, tagged: ReadonlySet<string>): Map<string, Mark> {
  const dirs = new Set(choice.dirs);
  const single = new Set(choice.pageIds);
  const left = new Set(choice.leftOut);
  const out = new Map<string, Mark>();
  // Whether any page in the list, or under it, is read, and whether any is not.
  const walk = (nodes: PageTreeNode[], underDir: boolean, blocked: boolean): [boolean, boolean] => {
    let anyIn = false;
    let anyOut = false;
    for (const n of nodes) {
      const inDir = underDir || dirs.has(n.id);
      const isBlocked = blocked || left.has(n.id);
      const chosen = inDir || single.has(n.id) || tagged.has(n.id);
      const rule = titleLeftOut(n.title, choice.leaveOutTitles);
      const own: Own = isBlocked ? 'left' : chosen ? (rule ? 'rule' : 'in') : 'none';
      const [belowIn, belowOut] = walk(n.children, inDir, isBlocked);
      out.set(n.id, { own, chosen, mixed: own === 'in' ? belowOut : belowIn });
      anyIn ||= own === 'in' || belowIn;
      anyOut ||= own !== 'in' || belowOut;
    }
    return [anyIn, anyOut];
  };
  walk(tree, false, false);
  return out;
}

/** How many pages are read, and how many chosen pages are left out by a tick or a rule. */
export function count(all: Map<string, Mark>): { read: number; leftOut: number } {
  let read = 0;
  let leftOut = 0;
  for (const m of all.values()) {
    if (m.own === 'in') read++;
    else if (m.chosen && m.own !== 'none') leftOut++;
  }
  return { read, leftOut };
}

const below = (node: PageTreeNode): Set<string> => new Set(node.children.flatMap((c) => [c.id, ...below(c)]));

/**
 * The choice after a page is ticked or unticked. Ticking takes a page with pages under it as a
 * directory, and a page alone otherwise, or brings back a page that was left out; unticking clears
 * what was chosen at and under it, and leaves it out if a directory above it or a tag still takes it.
 *
 * @param choice What is chosen now.
 * @param node The page.
 * @param on Ticked or unticked.
 * @param ownOf The page's state under a choice, from `marks`.
 */
export function toggle(choice: Choice, node: PageTreeNode, on: boolean, ownOf: (c: Choice) => Own): Choice {
  const under = below(node);
  const keep = (ids: string[]): string[] => ids.filter((id) => id !== node.id && !under.has(id));
  if (on) {
    const back = { ...choice, leftOut: choice.leftOut.filter((id) => id !== node.id) };
    if (ownOf(back) === 'in') return back;
    const cleared = { ...back, dirs: keep(back.dirs), pageIds: keep(back.pageIds), leftOut: keep(back.leftOut) };
    return node.children.length
      ? { ...cleared, dirs: [...cleared.dirs, node.id] }
      : { ...cleared, pageIds: [...cleared.pageIds, node.id] };
  }
  const cleared = { ...choice, dirs: keep(choice.dirs), pageIds: keep(choice.pageIds), leftOut: keep(choice.leftOut) };
  return ownOf(cleared) === 'in' ? { ...cleared, leftOut: [...cleared.leftOut, node.id] } : cleared;
}
