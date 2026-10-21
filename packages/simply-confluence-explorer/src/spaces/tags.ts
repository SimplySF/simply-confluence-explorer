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

// Pages grouped by tag, so pages about one subject can be found wherever they sit in a space. A
// page's tags are the topic tags from its AI summary together with its Confluence labels, so a space
// without summaries still has tags (ADR-046).

import type { PageDetail, TaggedPages } from '../api/types.js';
import type { SpaceStore } from './spaceStore.js';

/** A page's tags, lower-cased, each once. */
export function tagsOf(page: Pick<PageDetail, 'labels'>, metadata?: { tags?: string[] }): string[] {
  const all = [...page.labels, ...(metadata?.tags ?? [])].map((t) => t.trim().toLowerCase()).filter(Boolean);
  return [...new Set(all)];
}

/**
 * Every tag in a synced space with the pages that carry it, most-used first, from the space's
 * catalog (ADR-064), so no page file is read. An excluded page is never listed, nor its title sent
 * anywhere.
 *
 * @param store The synced copy.
 * @param spaceKey The space.
 */
export async function tagIndex(store: SpaceStore, spaceKey: string): Promise<TaggedPages[]> {
  const byTag = new Map<string, TaggedPages['pages']>();
  for (const page of await store.visibleEntries(spaceKey)) {
    const entry = {
      id: page.id,
      title: page.title,
      path: page.ancestors.map((a) => a.title).join(' › '),
      summary: page.summary,
    };
    for (const tag of tagsOf(page, page)) byTag.set(tag, [...(byTag.get(tag) ?? []), entry]);
  }
  return [...byTag]
    .map(([tag, pages]) => ({ tag, pages: pages.sort((a, b) => a.title.localeCompare(b.title)) }))
    .sort((a, b) => b.pages.length - a.pages.length || a.tag.localeCompare(b.tag));
}
