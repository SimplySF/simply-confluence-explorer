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

import { markdownToStorage, storageToMarkdown } from '@simplysf/simply-atlassian-core';
import yaml from 'yaml';
import type { PageDetail, ParsedPage } from '../api/types.js';

/**
 * Converts a page to Markdown with a frontmatter block in front of it. The frontmatter records
 * where the page came from (its id, space, version and Confluence address), so a saved copy can be
 * traced back to its source and a later push can say which version it was made from.
 *
 * @param page The page as read from Confluence.
 */
export function parsePage(page: PageDetail): ParsedPage {
  const frontmatter: Record<string, unknown> = {
    id: page.id,
    title: page.title,
    space: page.spaceKey,
    version: page.version,
    author: page.author,
    updatedAt: page.lastModified,
  };
  if (page.labels.length > 0) frontmatter.labels = page.labels;
  if (page.webUrl) frontmatter.confluenceUrl = page.webUrl;
  if (page.ancestors.length > 0) frontmatter.breadcrumbs = page.ancestors.map((a) => a.title);

  const body = storageToBody(page.storageXml);
  return {
    pageId: page.id,
    title: page.title,
    spaceKey: page.spaceKey,
    frontmatter,
    markdown: `---\n${yaml.stringify(frontmatter).trim()}\n---\n\n${body}\n`,
  };
}

/**
 * Converts Confluence storage format, the XHTML-based format Confluence keeps pages in, to Markdown.
 *
 * @param storageXml The page body in storage format.
 */
export function storageToBody(storageXml: string): string {
  return storageToMarkdown(storageXml).trim();
}

/** The parts of a page that a rewrite from Markdown could drop, with a person's name for one and for several. */
const PARTS: Array<[RegExp, string, string]> = [
  [/<ac:image\b/g, 'image', 'images'],
  [/<ac:link\b[^>]*>\s*<ri:page\b/g, 'link to another page', 'links to other pages'],
  [/<ri:user\b/g, 'mention of a person', 'mentions of people'],
  [/<ac:task-list\b/g, 'task list', 'task lists'],
  [/<ac:layout\b/g, 'page layout', 'page layouts'],
];

/** Counts each kind of part in a page, keyed by its singular name; macros are counted by their own name. */
function partsOf(storage: string): Map<string, { n: number; plural: string }> {
  const counts = new Map<string, { n: number; plural: string }>();
  const add = (one: string, many: string): void => {
    counts.set(one, { n: (counts.get(one)?.n ?? 0) + 1, plural: many });
  };
  for (const [pattern, one, many] of PARTS) {
    const n = storage.match(pattern)?.length ?? 0;
    if (n > 0) counts.set(one, { n, plural: many });
  }
  for (const m of storage.matchAll(/<ac:structured-macro\b[^>]*\bac:name="([^"]+)"/g)) {
    add(`"${m[1]}" macro`, `"${m[1]}" macros`);
  }
  return counts;
}

/**
 * Names what a page would lose if its body were replaced by its own Markdown written back. Pages
 * are edited as Markdown, and Markdown has no form for an image, a macro such as a status label or a
 * panel, a link to another page, a mention or a task list, so converting the page shows each one as
 * placeholder text, and writing that text back would replace the real thing with the placeholder.
 * The page is converted to Markdown and back, and whatever is present before and missing after is
 * reported, so this follows the converter as it learns to carry more. A task list cannot be written
 * from Markdown at all, so it is counted as lost before the rest of the page is tried.
 *
 * @param storageXml The page as Confluence holds it now.
 * @returns One phrase per kind of part that would be lost, such as `2 images`; empty when nothing would.
 */
export function lostInRewrite(storageXml: string): string[] {
  const before = partsOf(storageXml);
  const withoutTasks = storageXml.replace(/<ac:task-list\b[\s\S]*?<\/ac:task-list>/g, '');
  let after: Map<string, { n: number; plural: string }>;
  try {
    after = partsOf(markdownToStorage(storageToMarkdown(withoutTasks)));
  } catch {
    // The page's own Markdown could not be written back at all, so nothing in it can be assumed kept.
    after = new Map();
  }
  return [...before].flatMap(([one, { n, plural }]) => {
    const lost = n - (after.get(one)?.n ?? 0);
    if (lost <= 0) return [];
    return [lost === 1 ? `1 ${one}` : `${lost} ${plural}`];
  });
}

/**
 * Removes the frontmatter block that `parsePage` writes, so that it is never pushed into a page.
 *
 * @param markdown A page body that may start with frontmatter.
 */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').replace(/^\s*\n/, '');
}
