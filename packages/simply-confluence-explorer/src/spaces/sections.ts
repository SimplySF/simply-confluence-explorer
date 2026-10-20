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

import { stripFrontmatter } from '../parser/convert.js';

// A page split into sections at its headings, the unit that retrieval searches, summarises, embeds
// and sends (ADR-051). A question about a large corpus needs the part of a page that answers it, not
// the whole page, so a corpus of thousands of pages can still fit one request.

/** The most characters one section holds; a longer one is split at its paragraph breaks. */
export const SECTION_CHARS = 2500;

export type Section = {
  pageId: string;
  /** Its position in the page, from 0. With the page id it names the section. */
  index: number;
  /** The headings above it and its own, such as ["Runbook", "Rollback"]; empty before the first heading. */
  path: string[];
  text: string;
};

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Breaks text longer than a section into parts at paragraph breaks, cutting a paragraph only when it alone is too long. */
function parts(text: string): string[] {
  if (text.length <= SECTION_CHARS) return [text];
  const out: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    for (let rest = paragraph; rest.length > 0; rest = rest.slice(SECTION_CHARS)) {
      const piece = rest.slice(0, SECTION_CHARS);
      if (current && current.length + piece.length + 2 > SECTION_CHARS) {
        out.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Splits a page's Markdown at its first three levels of heading. A heading inside a code block is
 * text, and a heading with no text of its own before the next one makes no section, though it stays
 * in the path of the sections under it.
 *
 * @param pageId The page the Markdown is from.
 * @param markdown The page as Markdown, with or without the frontmatter the app writes.
 */
export function splitSections(pageId: string, markdown: string): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let body: string[] = [];
  let fenced = false;
  const flush = (): void => {
    const text = body.join('\n').trim();
    body = [];
    if (!text) return;
    const path = stack.map((h) => h.title);
    for (const part of parts(text)) sections.push({ pageId, index: sections.length, path, text: part });
  };
  for (const line of stripFrontmatter(markdown).split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    if (!heading) {
      body.push(line);
      continue;
    }
    flush();
    const level = heading[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: heading[2] });
  }
  flush();
  return sections;
}

/** The headings above a section, without a first heading that only repeats the page's title, as many pages open with. */
function ownPath(pageTitle: string, section: Pick<Section, 'path'>): string[] {
  return section.path[0]?.trim().toLowerCase() === pageTitle.trim().toLowerCase() ? section.path.slice(1) : section.path;
}

/** A section's heading within its page, such as "Deploy › Rollback", or "Introduction" before the first one. */
export function headingOf(pageTitle: string, section: Pick<Section, 'path'>): string {
  return ownPath(pageTitle, section).join(' › ') || 'Introduction';
}

/** A section's name as an answer cites it, such as "Runbook › Rollback". */
export function sectionName(pageTitle: string, section: Pick<Section, 'path'>): string {
  return [pageTitle, ...ownPath(pageTitle, section)].join(' › ');
}
