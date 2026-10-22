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

// A synced page's attachments, as the AI reads them with the page (ADR-066, ADR-069). Text attachments
// become sections of the page's text, so the guard checks them and search finds them like the page.
// Images are listed, and their bytes read only for a space that chooses to send images. Every file
// that is not read, or not read whole, is named with why, so no attachment is left out unsaid. Every
// caller has already checked the page against the exclusion rules, so an excluded page's files are
// never read.

import fs from 'node:fs';
import path from 'node:path';
import type { AttachmentChoice, AttachmentsReport, ImageChoice, ImagesReport, PageDetail } from '../api/types.js';
import type { ImageInput } from '../ai/guard.js';
import { errorMessage } from '../util/errors.js';
import { documentText, formatOf } from './documentText.js';

/** The most of one attachment's text read, and of all a page's attachments together. */
export const ATTACHMENT_CHARS = 50_000;
export const PAGE_ATTACHMENT_CHARS = 100_000;
/** The largest image sent, every provider's limit, and the most images sent with one page. */
export const IMAGE_BYTES = 5 * 1024 * 1024;
export const PAGE_IMAGES = 10;
/** The most images, and bytes of them, one request carries. */
export const REQUEST_IMAGES = 20;
export const REQUEST_IMAGE_BYTES = 10 * 1024 * 1024;
/** How long a request waits for PDFs still being read before it goes without them, naming them. */
export const PDF_WAIT_MS = 30_000;

export const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export type AttachmentFile = { title: string; mediaType: string; file: string; bytes: number; missing?: boolean };
export type PageImage = { name: string; mediaType: string; file: string; bytes: number };
/** What reading a page's attachments found: their text, the images, and what was not read, with why. */
export type PageAttachments = {
  /** The text attachments as Markdown sections, or empty. */
  text: string;
  /** Each file read as text, what it was read as, and how many characters were kept when it was cut. */
  read: Array<{ name: string; as: string; cut?: number }>;
  images: PageImage[];
  unread: Array<{ name: string; why: string }>;
};

const extensionOf = (a: AttachmentFile): string => path.extname(a.title).toLowerCase();

export class AttachmentReader {
  // Extracted text, by file, with the file time it was read at, so a file is read once.
  private readonly texts = new Map<string, { mtimeMs: number; text: string; as: string }>();
  // PDFs being read, as reading one can take a while; a request waits for them in prepare().
  private readonly reading = new Map<string, Promise<void>>();

  public constructor(
    private readonly files: (spaceKey: string, page: PageDetail) => AttachmentFile[],
    private readonly log: (message: string) => void,
    private readonly synced: (spaceKey: string) => boolean = () => true,
  ) {}

  /** A page's attachments as the AI reads them. */
  public of(spaceKey: string, page: PageDetail): PageAttachments {
    const result: PageAttachments = { text: '', read: [], images: [], unread: [] };
    let used = 0;
    for (const a of this.files(spaceKey, page)) {
      if (a.missing) {
        result.unread.push({
          name: a.title,
          why: this.synced(spaceKey)
            ? 'not on this machine: sync the space again to download it'
            : 'this space is not synced, so its attachments are not downloaded',
        });
        continue;
      }
      const ext = extensionOf(a);
      if (IMAGE_TYPES[ext]) {
        if (a.bytes > IMAGE_BYTES) result.unread.push({ name: a.title, why: 'an image larger than 5 MB' });
        else if (result.images.length >= PAGE_IMAGES)
          result.unread.push({ name: a.title, why: `an image past the first ${PAGE_IMAGES} on the page` });
        else result.images.push({ name: a.title, mediaType: IMAGE_TYPES[ext], file: a.file, bytes: a.bytes });
        continue;
      }
      const read = this.textOf(a, ext);
      if ('why' in read) {
        result.unread.push({ name: a.title, why: read.why });
        continue;
      }
      const room = PAGE_ATTACHMENT_CHARS - used;
      if (room <= 0) {
        result.unread.push({
          name: a.title,
          why: `the page's attachments already fill their ${PAGE_ATTACHMENT_CHARS.toLocaleString('en')} characters`,
        });
        continue;
      }
      const cap = Math.min(ATTACHMENT_CHARS, room);
      const cut = read.text.length > cap;
      const kept = cut ? `${read.text.slice(0, cap)}\n(…cut to its first ${cap} characters)` : read.text;
      used += Math.min(read.text.length, cap);
      result.read.push({ name: a.title, as: read.as, ...(cut ? { cut: cap } : {}) });
      result.text += `\n\n## Attachment: ${a.title}\n\n${kept.trim()}`;
    }
    return result;
  }

  /**
   * Waits for the PDFs of these pages to be read, so a request sends their text rather than going
   * without it; one that takes longer than `PDF_WAIT_MS` is named as still being read.
   */
  public async prepare(pages: Array<{ spaceKey: string; page: PageDetail }>, waitMs = PDF_WAIT_MS): Promise<void> {
    const pending: Array<Promise<void>> = [];
    for (const { spaceKey, page } of pages)
      for (const a of this.files(spaceKey, page))
        if (!a.missing && extensionOf(a) === '.pdf') {
          const stat = fs.statSync(a.file, { throwIfNoEntry: false });
          if (stat && this.texts.get(a.file)?.mtimeMs !== stat.mtimeMs)
            pending.push(this.readPdf(a.file, stat.mtimeMs));
        }
    if (pending.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** An attachment's text and what it was read as, or why it has none to give. */
  private textOf(a: AttachmentFile, ext: string): { text: string; as: string } | { why: string } {
    const stat = fs.statSync(a.file, { throwIfNoEntry: false });
    if (!stat) return { why: 'not on this machine: sync the space again to download it' };
    const kept = this.texts.get(a.file);
    if (kept?.mtimeMs === stat.mtimeMs) return kept;
    if (ext === '.pdf') {
      void this.readPdf(a.file, stat.mtimeMs);
      return { why: 'a PDF still being read when this was sent; its text goes with the next question' };
    }
    const read = documentText(a.title, a.mediaType, fs.readFileSync(a.file));
    if ('text' in read) this.texts.set(a.file, { mtimeMs: stat.mtimeMs, ...read });
    return read;
  }

  /** Reads a PDF's text, once however many ask while it is read. */
  private readPdf(file: string, mtimeMs: number): Promise<void> {
    const started = this.reading.get(file);
    if (started) return started;
    const reading = (async (): Promise<void> => {
      try {
        const { extractText, getDocumentProxy } = await import('unpdf');
        const { text } = await extractText(await getDocumentProxy(new Uint8Array(fs.readFileSync(file))), {
          mergePages: true,
        });
        this.texts.set(file, { mtimeMs, as: 'PDF', text: text.trim() || '(This PDF has no text; it may be a scan.)' });
      } catch (error) {
        this.log(`could not read the text of ${path.basename(file)}: ${errorMessage(error)}`);
        this.texts.set(file, { mtimeMs, as: 'PDF', text: '(This PDF could not be read.)' });
      } finally {
        this.reading.delete(file);
      }
    })();
    this.reading.set(file, reading);
    return reading;
  }
}

/**
 * The account of the attachments a request read with its pages, and the images it sends: every file
 * read, sent, or named with why it was not (ADR-069).
 *
 * @param of Reads a page's attachments.
 * @param pages The pages the request reads, with their space.
 * @param choices The chat's choice about attachments (unanswered reads them), and the space's about images.
 */
export function attachmentsFor(
  of: (spaceKey: string, page: PageDetail) => PageAttachments,
  pages: Array<{ spaceKey: string; page: PageDetail }>,
  choices: { chat?: AttachmentChoice; images: ImageChoice },
): { images: ImageInput[]; report: AttachmentsReport } {
  const report: AttachmentsReport = {
    files: 0,
    read: [],
    unread: [],
    images: { found: 0, sent: 0, choice: choices.images },
  };
  if (choices.chat) report.choice = choices.chat;
  if (choices.chat === 'pages') {
    for (const { page } of pages)
      for (const a of page.attachments) {
        report.files++;
        report.unread.push({ page: page.title, name: a.title, why: 'this chat reads pages only' });
      }
    return { images: [], report };
  }
  const sent = imagesFor(of, choices.images, pages);
  report.images = sent.report;
  const went = new Set(sent.images.map((i) => i.name));
  const imageWhy =
    choices.images === 'skip'
      ? 'an image: images are off for this space'
      : 'an image: sent only once you choose to send images for this space';
  for (const { spaceKey, page } of pages) {
    const read = of(spaceKey, page);
    report.files += read.read.length + read.images.length + read.unread.length;
    report.read.push(...read.read.map((r) => ({ page: page.title, ...r })));
    report.unread.push(...read.unread.map((u) => ({ page: page.title, ...u })));
    for (const image of read.images)
      if (!went.has(`${page.title} / ${image.name}`))
        report.unread.push({
          page: page.title,
          name: image.name,
          why: choices.images === 'send' ? 'an image left out to keep the request within its limits' : imageWhy,
        });
  }
  return { images: sent.images, report };
}

/**
 * The images a request sends with the pages it read: none unless the space chose to send them, then
 * each page's, up to the request's limits, with what did not fit named. Either way it says how many
 * the pages hold, so the person can be asked (ADR-066).
 *
 * @param of Reads a page's attachments.
 * @param choice The space's choice about images.
 * @param pages The pages the request reads, with their space.
 */
export function imagesFor(
  of: (spaceKey: string, page: PageDetail) => PageAttachments,
  choice: ImageChoice,
  pages: Array<{ spaceKey: string; page: PageDetail }>,
): { images: ImageInput[]; report: ImagesReport } {
  const images: ImageInput[] = [];
  const left: string[] = [];
  let found = 0;
  let bytes = 0;
  for (const { spaceKey, page } of pages) {
    const read = of(spaceKey, page);
    found += read.images.length + read.unread.filter((u) => IMAGE_TYPES[path.extname(u.name).toLowerCase()]).length;
    if (choice !== 'send') continue;
    for (const image of read.images) {
      if (images.length >= REQUEST_IMAGES || bytes + image.bytes > REQUEST_IMAGE_BYTES) {
        left.push(image.name);
        continue;
      }
      bytes += image.bytes;
      images.push({
        name: `${page.title} / ${image.name}`,
        mediaType: image.mediaType,
        data: fs.readFileSync(image.file),
      });
    }
  }
  return { images, report: { found, sent: images.length, choice, ...(left.length ? { left } : {}) } };
}

/** The accounts of several requests that read different pages, as the one answer they made gives it. */
export function mergeAccounts(reports: AttachmentsReport[], images: ImageChoice): AttachmentsReport {
  const left = reports.flatMap((r) => r.images.left ?? []);
  const merged: AttachmentsReport = {
    files: reports.reduce((n, r) => n + r.files, 0),
    read: reports.flatMap((r) => r.read),
    unread: reports.flatMap((r) => r.unread),
    images: {
      found: reports.reduce((n, r) => n + r.images.found, 0),
      sent: reports.reduce((n, r) => n + r.images.sent, 0),
      choice: images,
      ...(left.length ? { left } : {}),
    },
  };
  const choice = reports.find((r) => r.choice)?.choice;
  return choice ? { ...merged, choice } : merged;
}

/**
 * What a chat will read of its pages' attachments, judged from their names and types without reading
 * them, so the list shows at once before the first question, however many pages are chosen (ADR-069).
 *
 * @param files Each page's attachments, as the store lists them, missing ones marked.
 * @param choices The chat's choice about attachments, and the space's about images.
 * @param synced Whether the space is synced, for why a missing file is missing.
 */
export function previewAccount(
  files: Array<{ page: string; entries: AttachmentFile[] }>,
  choices: { chat?: AttachmentChoice; images: ImageChoice },
  synced: boolean,
): AttachmentsReport {
  const report: AttachmentsReport = {
    files: 0,
    read: [],
    unread: [],
    images: { found: 0, sent: 0, choice: choices.images },
  };
  if (choices.chat) report.choice = choices.chat;
  for (const { page, entries } of files)
    for (const a of entries) {
      report.files++;
      const name = a.title;
      if (choices.chat === 'pages') report.unread.push({ page, name, why: 'this chat reads pages only' });
      else if (a.missing)
        report.unread.push({
          page,
          name,
          why: synced
            ? 'not on this machine: sync the space again to download it'
            : 'this space is not synced, so its attachments are not downloaded',
        });
      else if (IMAGE_TYPES[path.extname(name).toLowerCase()]) report.images.found++;
      else {
        const format = formatOf(name, a.mediaType);
        if ('as' in format) report.read.push({ page, name, as: format.as });
        else report.unread.push({ page, name, why: format.why });
      }
    }
  return report;
}

/**
 * The account once a provider gave no answer with some of the images sent and was asked again
 * without them: those images are named as not read rather than counted as sent (ADR-069).
 *
 * @param report The account the request was sent with, changed in place.
 * @param dropped The images' names as they were sent, "page / file".
 */
export function withoutImages(report: AttachmentsReport, dropped: string[] | undefined): AttachmentsReport {
  if (!dropped?.length) return report;
  report.images.sent = Math.max(0, report.images.sent - dropped.length);
  for (const name of dropped) {
    const [page, ...file] = name.split(' / ');
    report.unread.push({
      page,
      name: file.join(' / ') || name,
      why: 'not read: the AI gave no answer with the images, so it was asked again without them',
    });
  }
  return report;
}
