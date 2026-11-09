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
import { askStructured, UnusableReply, type StructuredPrompt } from '../ai/structured.js';
import { errorMessage } from '../util/errors.js';
import { ENTRY_SCHEMA, fieldRules, METADATA_EXAMPLE, packEntryProblem, toMetadata } from './metadata.js';
import { sectionName, splitSections } from './sections.js';

// Indexing several small pages in one request, so a space of thousands of pages takes hundreds of
// requests rather than thousands (ADR-054). Every page sent must come back in the reply, described
// well enough to keep (ADR-079); one that does not is reported, so the caller can ask for it on its own.

/** About how many characters one indexing request carries, so small pages share a request. */
export const PACK_CHARS = 60_000;
/** The same for an engine that reads a long request poorly, such as the Gemini CLI. */
export const SMALL_PACK_CHARS = 25_000;
/** The most of one page an indexing request carries; a longer page sends its headings and the start of each section. */
export const PAGE_CHARS = 200_000;
/** How many sections are summarised; the rest of a very long page is found by its words alone. */
const SUMMARISED_SECTIONS = 60;

/** The pack size for an engine. */
export const packLimit = (ai: Pick<AiEngine, 'smallPacks'>): number =>
  ai.smallPacks?.() ? SMALL_PACK_CHARS : PACK_CHARS;

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

function packPrompt(count: number, vocabulary: string[]): StructuredPrompt {
  return {
    task: `Read each of the ${count} Confluence pages below and return a JSON object with one entry for every page.`,
    rules: [
      `"pages" holds ${count} entries, one for each page, in the order the pages appear. Copy each entry's "id" from its page's "=== PAGE <id>: <title> ===" line.`,
      ...fieldRules(
        vocabulary,
        '"sections": one short line for each section in the page\'s "Sections:" list, in the same order, as many lines as the list has.',
      ),
    ],
    example: JSON.stringify({ pages: [{ id: '12345', ...METADATA_EXAMPLE }] }),
  };
}

/** A pack reply as a JSON Schema; made when asked for, as `metadata.ts` imports this module too. */
const packSchema = (): Record<string, unknown> => ({
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: { ...ENTRY_SCHEMA, properties: { id: { type: 'string' }, ...ENTRY_SCHEMA.properties } },
    },
  },
  required: ['pages'],
});

/**
 * Asks for the metadata of several pages in one request. Each page comes back as its metadata, or as
 * the reason it did not: missing from the reply, described too thinly to keep, or the reply unusable
 * even after one repair.
 */
export async function generateMetadataPack(
  pages: PageDetail[],
  ai: AiEngine,
  vocabulary: string[],
  markdownOf: (page: PageDetail) => string = (p) => parsePage(p).markdown,
  images: ImageInput[] = [],
): Promise<Map<string, PageMetadata | Error>> {
  const parts = pages.map((p) => ({ page: p, ...described(p, markdownOf) }));
  const sent = new Set(pages.map((p) => p.id));
  const reply = await askStructured({
    ai,
    input: parts.map((p) => p.text).join('\n\n'),
    prompt: packPrompt(pages.length, vocabulary),
    schema: packSchema(),
    validate: (json) => {
      const raw = (json as { pages?: unknown } | null)?.pages;
      if (!Array.isArray(raw)) return 'it held no list of pages';
      const entries = raw.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
      return entries.some((e) => sent.has(String(e.id))) ? entries : 'none of its entries had the id of a page sent';
    },
    label: `${pages.length} pages`,
    spaceKey: pages[0].spaceKey,
    images,
  });
  const results = new Map<string, PageMetadata | Error>();
  if (!reply.ok) {
    // Unusable as a whole: every page is reported, and the caller asks for each on its own.
    for (const p of pages) results.set(p.id, new Error(`the AI reply could not be read: ${reply.reason}`));
    return results;
  }
  const byId = new Map(reply.value.filter((e) => e.id !== undefined).map((e) => [String(e.id), e]));
  for (const p of parts) {
    const entry = byId.get(p.page.id);
    const problem = entry ? packEntryProblem(entry, p.headings.length) : 'the AI reply left this page out';
    results.set(p.page.id, entry && !problem ? toMetadata(p.page, entry, p.headings) : new Error(problem!));
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
      // A reply already asked for twice would not improve by asking the same way a third time.
      if (attempt >= 2 || stopped() || error instanceof UnusableReply) throw error;
      // eslint-disable-next-line no-await-in-loop -- the pause before trying again
      await new Promise((resolve) => setTimeout(resolve, delayMs * (limited ? 5 : 1) * (attempt + 1)));
    }
  }
}
