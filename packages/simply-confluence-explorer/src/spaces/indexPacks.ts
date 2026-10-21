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

import type { PageDetail, PageMetadata } from '../api/types.js';
import type { AiEngine } from '../ai/engine.js';
import type { ImageInput } from '../ai/guard.js';
import { parsePage, stripFrontmatter } from '../parser/convert.js';
import { errorMessage } from '../util/errors.js';
import { toMetadata } from './metadata.js';
import { sectionName, splitSections } from './sections.js';

// Indexing several small pages in one request, so a space of thousands of pages takes hundreds of
// requests rather than thousands (ADR-054). Every page sent must come back in the reply; one that does
// not is reported, so the caller can ask for it on its own.

/** About how many characters one indexing request carries, so small pages share a request. */
export const PACK_CHARS = 60_000;
/** The most of one page an indexing request carries; a longer page sends its headings and the start of each section. */
export const PAGE_CHARS = 200_000;
/** How many sections are summarised; the rest of a very long page is found by its words alone. */
const SUMMARISED_SECTIONS = 60;
/** How many of a space's topics the prompt offers. */
const VOCABULARY = 60;

/**
 * Groups pages into packs no larger than `limit`, by each page's stored size, in the order given. A
 * page at or over the limit goes alone.
 */
export function packPages(pages: PageDetail[], limit = PACK_CHARS): PageDetail[][] {
  const packs: PageDetail[][] = [];
  let current: PageDetail[] = [];
  let used = 0;
  for (const page of pages) {
    const size = page.storageXml.length;
    if (current.length && used + size > limit) {
      packs.push(current);
      current = [];
      used = 0;
    }
    current.push(page);
    used += size;
  }
  if (current.length) packs.push(current);
  return packs;
}

/** A page as an indexing request carries it: its sections listed, then its text, shortened if very long. */
function described(page: PageDetail, markdownOf: (page: PageDetail) => string): { text: string; headings: string[] } {
  const markdown = stripFrontmatter(markdownOf(page));
  const sections = splitSections(page.id, markdown);
  const headings = sections.slice(0, SUMMARISED_SECTIONS).map((s) => sectionName(page.title, s));
  const body =
    markdown.length <= PAGE_CHARS
      ? markdown
      : sections.map((s) => `${sectionName(page.title, s)}\n${s.text.slice(0, 500)}`).join('\n\n');
  const listed = headings.map((h, i) => `${i + 1}. ${h}`).join('\n');
  return { text: `=== PAGE ${page.id}: ${page.title} ===\nSections:\n${listed}\n\n${body}`, headings };
}

function packPrompt(vocabulary: string[]): string {
  return `Analyze each Confluence page below and return a JSON object with one entry for every page, in this exact schema:
{"pages": [{
  "id": "the id from the page's === PAGE <id>: <title> === line",
  "summary": "1-2 sentence summary of what this page is for",
  "tags": ["3 to 6 topics, lower case"],
  "documentType": "architecture" | "runbook" | "overview" | "policy" | "guide" | "reference",
  "systemsMentioned": ["SystemA", "SystemB"],
  "audience": "who reads this page, such as on-call engineers",
  "questions": ["up to 6 questions a reader could answer from this page"],
  "sections": ["one line on what each listed section says, in the same order"]
}]}
${vocabulary.length ? `Choose topics from this list when one fits, and add a new one only for a subject none of them covers: ${vocabulary.slice(0, VOCABULARY).join(', ')}.\n` : ''}Only output the valid JSON block, with no conversational filler.`;
}

/**
 * Asks for the metadata of several pages in one request. Each page comes back as its metadata, or as
 * the reason it did not: missing from the reply, or the reply unreadable.
 */
export async function generateMetadataPack(
  pages: PageDetail[],
  ai: AiEngine,
  vocabulary: string[],
  markdownOf: (page: PageDetail) => string = (p) => parsePage(p).markdown,
  images: ImageInput[] = [],
): Promise<Map<string, PageMetadata | Error>> {
  const parts = pages.map((p) => ({ page: p, ...described(p, markdownOf) }));
  const reply = (
    await ai.analyzeDocument(parts.map((p) => p.text).join('\n\n'), packPrompt(vocabulary), `${pages.length} pages`, {
      spaceKey: pages[0].spaceKey,
      ...(images.length ? { images } : {}),
    })
  ).text;
  const results = new Map<string, PageMetadata | Error>();
  let entries: Array<Record<string, unknown>>;
  try {
    const json = /\{[\s\S]*\}/.exec(reply);
    const raw = json ? (JSON.parse(json[0]) as { pages?: unknown }).pages : undefined;
    if (!Array.isArray(raw)) throw new Error('it held no list of pages');
    entries = raw as Array<Record<string, unknown>>;
  } catch (error) {
    // Unreadable as a whole: every page is reported, and the caller asks for each on its own.
    for (const p of pages) results.set(p.id, new Error(`the AI reply could not be read: ${errorMessage(error)}`));
    return results;
  }
  const byId = new Map(entries.filter((e) => e?.id !== undefined).map((e) => [String(e.id), e]));
  for (const p of parts) {
    const entry = byId.get(p.page.id);
    results.set(
      p.page.id,
      entry ? toMetadata(p.page, entry, p.headings) : new Error('the AI reply left this page out'),
    );
  }
  return results;
}

/**
 * Runs `fn`, trying again after a pause when it fails, longer when the provider says it is limiting
 * requests. A failure that remains after the last try is thrown.
 *
 * @param fn The request.
 * @param delayMs The first pause; a rate limit waits five times as long.
 * @param stopped Whether the run was stopped, so it does not wait to try again.
 */
export async function withRetry<T>(fn: () => Promise<T>, delayMs: number, stopped: () => boolean): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each try waits for the one before
      return await fn();
    } catch (error) {
      const limited = /429|rate.?limit|quota|too many requests|resource.?exhausted/i.test(errorMessage(error));
      if (attempt >= 2 || stopped()) throw error;
      // eslint-disable-next-line no-await-in-loop -- the pause before trying again
      await new Promise((resolve) => setTimeout(resolve, delayMs * (limited ? 5 : 1) * (attempt + 1)));
    }
  }
}
