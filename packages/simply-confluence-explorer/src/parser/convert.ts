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

/**
 * Removes the frontmatter block that `parsePage` writes, so that it is never pushed into a page.
 *
 * @param markdown A page body that may start with frontmatter.
 */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').replace(/^\s*\n/, '');
}
