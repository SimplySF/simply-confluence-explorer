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

// A synced page's attachments, as the AI reads them with the page (ADR-066). Text attachments become
// sections of the page's text, so the guard checks them and search finds them like the page. Images
// are listed, and their bytes read only for a space that chooses to send images. Every caller has
// already checked the page against the exclusion rules, so an excluded page's files are never read.

import fs from 'node:fs';
import path from 'node:path';
import type { PageDetail } from '../api/types.js';
import { storageToBody } from '../parser/convert.js';
import { errorMessage } from '../util/errors.js';

/** The most of one attachment's text read, and of all a page's attachments together. */
export const ATTACHMENT_CHARS = 50_000;
export const PAGE_ATTACHMENT_CHARS = 100_000;
/** The largest image sent, every provider's limit, and the most images sent with one page. */
export const IMAGE_BYTES = 5 * 1024 * 1024;
export const PAGE_IMAGES = 10;

const TEXT_TYPES = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log', '.xml']);
const HTML_TYPES = new Set(['.html', '.htm']);
export const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export type AttachmentFile = { title: string; mediaType: string; file: string; bytes: number };
export type PageImage = { name: string; mediaType: string; file: string; bytes: number };
/** What reading a page's attachments found: their text, the images, and what was not read, with why. */
export type PageAttachments = {
  /** The text attachments as Markdown sections, or empty. */
  text: string;
  read: string[];
  images: PageImage[];
  unread: Array<{ name: string; why: string }>;
};

const extensionOf = (a: AttachmentFile): string => path.extname(a.title).toLowerCase();

export class AttachmentReader {
  // Extracted text, by file, with the file time it was read at, so a file is read once.
  private readonly texts = new Map<string, { mtimeMs: number; text: string }>();
  // PDFs being read in the background: their text is ready the next time the page is read.
  private readonly reading = new Set<string>();

  public constructor(
    private readonly files: (spaceKey: string, page: PageDetail) => AttachmentFile[],
    private readonly log: (message: string) => void,
  ) {}

  /** A page's attachments as the AI reads them. */
  public of(spaceKey: string, page: PageDetail): PageAttachments {
    const result: PageAttachments = { text: '', read: [], images: [], unread: [] };
    let used = 0;
    for (const a of this.files(spaceKey, page)) {
      const ext = extensionOf(a);
      if (IMAGE_TYPES[ext]) {
        if (a.bytes > IMAGE_BYTES) result.unread.push({ name: a.title, why: 'larger than 5 MB' });
        else if (result.images.length >= PAGE_IMAGES)
          result.unread.push({ name: a.title, why: `more than ${PAGE_IMAGES} images on the page` });
        else result.images.push({ name: a.title, mediaType: IMAGE_TYPES[ext], file: a.file, bytes: a.bytes });
        continue;
      }
      const text = this.textOf(a, ext);
      if (typeof text !== 'string') {
        result.unread.push({ name: a.title, why: text.why });
        continue;
      }
      const room = PAGE_ATTACHMENT_CHARS - used;
      if (room <= 0) {
        result.unread.push({ name: a.title, why: 'the page’s attachments already fill their share' });
        continue;
      }
      const cap = Math.min(ATTACHMENT_CHARS, room);
      const kept = text.length > cap ? `${text.slice(0, cap)}\n(…cut to its first ${cap} characters)` : text;
      used += Math.min(text.length, cap);
      result.read.push(a.title);
      result.text += `\n\n## Attachment: ${a.title}\n\n${kept.trim()}`;
    }
    return result;
  }

  /** An attachment's text, or why it has none to give. */
  private textOf(a: AttachmentFile, ext: string): string | { why: string } {
    const stat = fs.statSync(a.file, { throwIfNoEntry: false });
    if (!stat) return { why: 'not on this machine' };
    const kept = this.texts.get(a.file);
    if (kept?.mtimeMs === stat.mtimeMs) return kept.text;
    if (ext === '.pdf') return this.readPdf(a.file, stat.mtimeMs);
    if (!TEXT_TYPES.has(ext) && !HTML_TYPES.has(ext)) return { why: 'not a kind of file the AI reads' };
    const bytes = fs.readFileSync(a.file);
    if (bytes.includes(0)) return { why: 'looks like a binary file' };
    const text = HTML_TYPES.has(ext) ? storageToBody(bytes.toString('utf8')) : bytes.toString('utf8');
    this.texts.set(a.file, { mtimeMs: stat.mtimeMs, text });
    return text;
  }

  /** Starts reading a PDF's text in the background, as reading one can take a while. */
  private readPdf(file: string, mtimeMs: number): { why: string } {
    if (!this.reading.has(file)) {
      this.reading.add(file);
      void (async (): Promise<void> => {
        try {
          const { extractText, getDocumentProxy } = await import('unpdf');
          const { text } = await extractText(await getDocumentProxy(new Uint8Array(fs.readFileSync(file))), {
            mergePages: true,
          });
          this.texts.set(file, { mtimeMs, text: text.trim() || '(This PDF has no text; it may be a scan.)' });
        } catch (error) {
          this.log(`could not read the text of ${path.basename(file)}: ${errorMessage(error)}`);
          this.texts.set(file, { mtimeMs, text: '(This PDF could not be read.)' });
        } finally {
          this.reading.delete(file);
        }
      })();
    }
    return { why: 'a PDF being read now; its text is sent from the next request' };
  }
}
