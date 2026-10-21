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

import { storageToMarkdown } from '@simplysf/simply-atlassian-core';
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
  const body = storageToBody(page.storageXml);
  return {
    pageId: page.id,
    title: page.title,
    spaceKey: page.spaceKey,
    frontmatter: frontmatterFields(page),
    markdown: `${frontmatterOf(page)}\n${body}\n`,
  };
}

/** The fields of a page's frontmatter: the app's record of the page, which is never text for the page. */
export const RECORD_FIELDS = [
  'id',
  'title',
  'space',
  'version',
  'author',
  'updatedAt',
  'labels',
  'confluenceUrl',
  'breadcrumbs',
] as const;

function frontmatterFields(page: PageDetail): Record<string, unknown> {
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
  return frontmatter;
}

/**
 * The frontmatter block `parsePage` writes at the top of a page's Markdown, followed by a blank line.
 * It is built from the page's details alone, so its size is known without converting the page.
 *
 * @param page The page as read from Confluence.
 */
export function frontmatterOf(page: PageDetail): string {
  return `---\n${yaml.stringify(frontmatterFields(page)).trim()}\n---\n`;
}

/**
 * Converts Confluence storage format, the XHTML-based format Confluence keeps pages in, to Markdown.
 *
 * @param storageXml The page body in storage format.
 */
export function storageToBody(storageXml: string): string {
  return storageToMarkdown(storageXml).trim();
}

/** The parts of a page a write could drop, with a person's name for one and for several. */
const PARTS: Array<[RegExp, string, string]> = [
  [/<ac:image\b/g, 'image', 'images'],
  [/<ac:link\b[^>]*>\s*<ri:page\b/g, 'link to another page', 'links to other pages'],
  [/<ac:link\b[^>]*>\s*<ri:attachment\b/g, 'link to an attachment', 'links to attachments'],
  [/<ac:link\b[^>]*\bac:anchor=/g, 'link to an anchor', 'links to anchors'],
  [/<ri:user\b/g, 'mention of a person', 'mentions of people'],
  [/<ac:task-list\b/g, 'task list', 'task lists'],
  [/<ac:layout\b/g, 'page layout', 'page layouts'],
  [/<ac:emoticon\b/g, 'emoticon', 'emoticons'],
  [/<ac:inline-comment-marker\b/g, 'inline comment', 'inline comments'],
  [/<ac:adf-extension\b/g, 'extension', 'extensions'],
  [/<time\b/g, 'date', 'dates'],
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
 * Names the parts of a page that one storage body holds and another lacks: images, macros counted
 * by name, links to pages, attachments and anchors, mentions, task lists, layouts, emoticons,
 * inline comments, extensions and dates. A write compares the page as Confluence holds it with what
 * it is about to send, so a part lost on the way is caught however it was lost.
 *
 * @param before The page as Confluence holds it now.
 * @param after The body about to be written.
 * @returns One phrase per kind of part that is missing, such as `2 images`; empty when nothing is.
 */
export function missingParts(before: string, after: string): string[] {
  const kept = partsOf(after);
  return [...partsOf(before)].flatMap(([one, { n, plural }]) => {
    const lost = n - (kept.get(one)?.n ?? 0);
    if (lost <= 0) return [];
    return [lost === 1 ? `1 ${one}` : `${lost} ${plural}`];
  });
}

/**
 * Removes the frontmatter block that `parsePage` writes, so that it is never pushed into a page. A
 * model that was shown a page can echo its title line and frontmatter, plain or in a yaml fence, so
 * those are removed from the start too, however many times they repeat.
 *
 * @param markdown A page body that may start with frontmatter.
 */
export function stripFrontmatter(markdown: string): string {
  let text = markdown.replace(/^\uFEFF/, '');
  for (let before = ''; before !== text;) {
    before = text;
    text = text
      .replace(/^\s*# Document Title:[^\n]*(\n|$)/i, '')
      .replace(/^\s*(?:```(?:ya?ml)?[ \t]*\r?\n)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n```[ \t]*)?(\r?\n|$)/, '');
  }
  return text.replace(/^\s*\n/, '');
}
