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

import type { PageDetail, PageTreeNode, SessionScope } from '../api/types.js';
import { mapChunked } from '../util/pause.js';
import type { ExclusionManager } from './exclusionManager.js';
import type { SpaceStore } from './spaceStore.js';
import { tagIndex } from './tags.js';

// The pages a chat reads from, its corpus (ADR-051), resolved from the synced copy on every turn so
// a page added under a chosen directory, or newly given a chosen tag, is read too, and a page excluded
// since is not.

/** The most page ids a chat's chosen pages may name, so a request cannot make the server check without end. */
export const MAX_CORPUS_IDS = 10_000;

/** The most title rules a chat's chosen pages may hold, and the longest each may be. */
export const MAX_TITLE_RULES = 20;
const MAX_RULE_LENGTH = 100;

const flatten = (nodes: PageTreeNode[]): PageTreeNode[] => nodes.flatMap((n) => [n, ...flatten(n.children)]);

/** Title rules from a request: trimmed, cut to length, without blanks or repeats, at most MAX_TITLE_RULES. */
export function titleRules(value: unknown): string[] {
  const rules = (Array.isArray(value) ? value : [])
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.trim().slice(0, MAX_RULE_LENGTH))
    .filter(Boolean);
  return [...new Set(rules)].slice(0, MAX_TITLE_RULES);
}

/** Whether a title rule leaves a page out. The browser asks the same, and a test checks the two agree. */
export const titleLeftOut = (title: string, rules: readonly string[]): boolean =>
  rules.some((rule) => title.toLowerCase().includes(rule.toLowerCase()));

/**
 * The synced pages a scope reads, in the order of the page tree, leaving out excluded pages.
 *
 * @param store The synced copy.
 * @param exclusions The space's rules.
 * @param scope A page, a directory, chosen directories, tags and pages, or the whole space.
 */
export async function corpusPages(
  store: SpaceStore,
  exclusions: ExclusionManager,
  scope: Pick<
    SessionScope,
    'kind' | 'spaceKey' | 'pageId' | 'pageIds' | 'dirs' | 'tags' | 'leftOut' | 'leaveOutTitles'
  >,
): Promise<PageDetail[]> {
  const key = scope.spaceKey.toUpperCase();
  await store.treeReady(key);
  const order = flatten(store.tree(key)).map((n) => n.id);
  const wanted = new Set<string>();
  const withTree = (id: string): void => {
    wanted.add(id);
    for (const n of store.descendants(key, id)) wanted.add(n.id);
  };
  if (scope.kind === 'space') order.forEach((id) => wanted.add(id));
  if (scope.kind === 'page' && scope.pageId) wanted.add(scope.pageId);
  if (scope.kind === 'branch' && scope.pageId) withTree(scope.pageId);
  if (scope.kind === 'pages') {
    (scope.dirs ?? []).forEach(withTree);
    (scope.pageIds ?? []).forEach((id) => wanted.add(id));
    const tags = new Set(scope.tags ?? []);
    for (const tagged of await tagIndex(store, key))
      if (tags.has(tagged.tag)) tagged.pages.forEach((p) => wanted.add(p.id));
    // Leaving out only ever removes pages, and the space's exclusion rules still apply after it.
    for (const id of scope.leftOut ?? []) {
      wanted.delete(id);
      for (const n of store.descendants(key, id)) wanted.delete(n.id);
    }
  }
  // Pages in the tree come in its order; any chosen page the tree does not hold yet comes last. Only
  // the chosen pages are read, in chunks, so choosing one page does not read the whole space.
  const inTree = new Set(order);
  const ids = [...order.filter((id) => wanted.has(id)), ...[...wanted].filter((id) => !inTree.has(id))];
  const pages = await mapChunked(ids, (id) => store.readPage(key, id));
  const excluded = exclusions.checker(key);
  const rules = scope.kind === 'pages' ? (scope.leaveOutTitles ?? []) : [];
  return pages.filter((page): page is PageDetail => !!page && !excluded(page) && !titleLeftOut(page.title, rules));
}
