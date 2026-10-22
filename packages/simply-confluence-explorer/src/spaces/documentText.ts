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

// The text of a file attached to a page, or uploaded to a chat, in every format the app reads, or
// why it has none (ADR-069). Office, OpenDocument and Visio files are zip archives of XML, read with
// the app's own zip reader; diagrams give the labels on their shapes, because their layout and
// styling are most of the file and none of its meaning. PDFs are read separately, as they take long.

import path from 'node:path';
import zlib from 'node:zlib';
import { storageToBody } from '../parser/convert.js';
import { errorMessage } from '../util/errors.js';
import { zipEntries, type ZipEntry } from '../util/zip.js';

/** A file's text and what kind of file it was read as, or why it was not read. */
export type DocumentText = { text: string; as: string } | { why: string };

const PLAIN = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.log',
  '.xml',
  '.mmd',
  '.puml',
  '.plantuml',
  '.sql',
  '.sh',
  '.bash',
  '.py',
  '.js',
  '.ts',
  '.java',
  '.go',
  '.rb',
  '.ps1',
  '.ini',
  '.toml',
  '.conf',
  '.cfg',
  '.properties',
  '.tf',
]);
export const readsAsText = (name: string): boolean => {
  const ext = path.extname(name).toLowerCase();
  return PLAIN.has(ext) || ext in READERS || ext === '.drawio';
};

const NOT_READ: Array<[RegExp, string]> = [
  [
    /^\.(doc|xls|ppt|pps|msg|vsd)$/,
    'an older binary format the app cannot read: save it as .docx, .xlsx, .pptx or .vsdx to have it read',
  ],
  [/^\.(pages|numbers|key)$/, 'an Apple format the app cannot read: export it as PDF or an Office file'],
  [/^\.(tiff?|bmp|heic|heif)$/, 'an image format the AI cannot take: attach it as PNG or JPEG'],
  [/^\.(mp4|mov|avi|mkv|webm|wmv|mp3|wav|m4a|aac|ogg|flac)$/, 'video and audio are not sent to the AI'],
];

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** XML text with its character references turned back into characters. */
export const decodeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (!ref.startsWith('#')) return ENTITIES[ref.toLowerCase()] ?? whole;
    const code = ref[1].toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
  });
const stripTags = (xml: string): string => decodeXml(xml.replace(/<[^>]*>/g, ''));
const tidy = (text: string): string =>
  text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+/, (s) => (s.includes('\t') ? '' : s)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const unique = (items: string[]): string[] => [...new Set(items.map((s) => s.trim()).filter(Boolean))];
const byNumber = (a: string, b: string): number =>
  Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

/**
 * The text of a file, in every format the app reads except PDF, or why it has none.
 *
 * @param name The file's name, whose extension says its format.
 * @param mediaType The type Confluence gives it, which names a diagram source that has no extension.
 * @param bytes The file.
 */
export function documentText(name: string, mediaType: string, bytes: Buffer): DocumentText {
  const ext = path.extname(name).toLowerCase();
  try {
    if (/gliffy/i.test(mediaType)) return gliffyText(bytes.toString('utf8'));
    if (/jgraph|drawio/i.test(mediaType) || ext === '.drawio') return drawioText(bytes.toString('utf8'));
    const reader = READERS[ext];
    if (reader) return { text: reader(bytes), as: FORMAT_NAMES[ext] };
    if (PLAIN.has(ext)) {
      if (bytes.includes(0)) return { why: 'looks like a binary file' };
      return { text: bytes.toString('utf8'), as: 'text' };
    }
  } catch (error) {
    return { why: `could not be read: ${errorMessage(error)}` };
  }
  return unreadable(ext);
}

const utf8 =
  (read: (text: string) => string) =>
  (bytes: Buffer): string =>
    read(bytes.toString('utf8'));
const zipped =
  (read: (entries: ZipEntry[]) => string) =>
  (bytes: Buffer): string =>
    read(zipEntries(bytes));
const READERS: Record<string, (bytes: Buffer) => string> = {
  '.html': utf8(storageToBody),
  '.htm': utf8(storageToBody),
  '.docx': zipped(docxText),
  '.xlsx': zipped(xlsxText),
  '.pptx': zipped(pptxText),
  '.vsdx': zipped(vsdxText),
  '.odt': zipped((e) => odfText(entry(e, 'content.xml'))),
  '.ods': zipped((e) => odfText(entry(e, 'content.xml'))),
  '.odp': zipped((e) => odfText(entry(e, 'content.xml'))),
  '.svg': utf8(svgText),
  '.bpmn': utf8(bpmnText),
  '.rtf': (bytes) => rtfText(bytes.toString('latin1')),
  '.eml': utf8(emlText),
  '.ics': utf8(icsText),
  '.ipynb': utf8(notebookText),
  '.zip': zipped(zipText),
};

const FORMAT_NAMES: Record<string, string> = {
  '.pdf': 'PDF',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.docx': 'Word',
  '.odt': 'OpenDocument',
  '.xlsx': 'Excel',
  '.ods': 'OpenDocument',
  '.pptx': 'PowerPoint',
  '.odp': 'OpenDocument',
  '.vsdx': 'Visio',
  '.drawio': 'draw.io',
  '.svg': 'SVG',
  '.bpmn': 'BPMN',
  '.rtf': 'RTF',
  '.eml': 'email',
  '.ics': 'calendar',
  '.ipynb': 'notebook',
  '.zip': 'archive',
};

function unreadable(ext: string): { why: string } {
  const known = NOT_READ.find(([pattern]) => pattern.test(ext));
  if (known) return { why: known[1] };
  return { why: ext ? `a ${ext} file, which the app does not read` : 'a file of a kind the app does not read' };
}

/**
 * What a file will be read as, or why it will not be, from its name and type alone, without reading
 * it, for the list a chat shows before its first question.
 *
 * @param name The file's name.
 * @param mediaType The type Confluence gives it.
 */
export function formatOf(name: string, mediaType: string): { as: string } | { why: string } {
  const ext = path.extname(name).toLowerCase();
  if (/gliffy/i.test(mediaType)) return { as: 'Gliffy' };
  if (/jgraph|drawio/i.test(mediaType)) return { as: 'draw.io' };
  if (FORMAT_NAMES[ext]) return { as: FORMAT_NAMES[ext] };
  if (PLAIN.has(ext)) return { as: 'text' };
  return unreadable(ext);
}

function entry(entries: ZipEntry[], name: string): string {
  const found = entries.find((e) => e.name === name);
  if (!found) throw new Error(`it has no ${name}`);
  return found.read().toString('utf8');
}

function docxText(entries: ZipEntry[]): string {
  const xml = entry(entries, 'word/document.xml')
    .replace(/<w:(instrText|delText)\b[^>]*>[\s\S]*?<\/w:\1>/g, '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    // A cell's paragraphs are one cell: its text on one line, then the next cell's.
    .replace(
      /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g,
      (_m, cell: string) =>
        `${cell
          .replace(/<\/w:p>/g, ' ')
          .replace(/<[^>]*>/g, '')
          .trim()} | `,
    )
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n');
  return tidy(stripTags(xml).replace(/ \| \n/g, '\n'));
}

/** A cell reference's column, from its letters: A is 0, Z 25, AA 26. */
const column = (ref: string): number =>
  [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const csvValue = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function xlsxText(entries: ZipEntry[]): string {
  const shared = [...entry(entries, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    stripTags(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')),
  );
  const rels: Record<string, string> = {};
  for (const m of entry(entries, 'xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g))
    rels[/\bId="([^"]+)"/.exec(m[0])?.[1] ?? ''] = /\bTarget="([^"]+)"/.exec(m[0])?.[1] ?? '';
  const sheets = [...entry(entries, 'xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: decodeXml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? 'Sheet'),
    target: rels[/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? ''] ?? '',
  }));
  return sheets
    .map(({ name, target }) => {
      const file = `xl/${target.replace(/^\/?xl\//, '')}`;
      const rows = [...entry(entries, file).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
        const cells: string[] = [];
        for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1];
          const inner = c[2] ?? '';
          const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
          const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          const value =
            type === 's'
              ? (shared[Number(raw)] ?? '')
              : type === 'inlineStr'
                ? stripTags(inner)
                : type === 'b'
                  ? raw === '1'
                    ? 'TRUE'
                    : 'FALSE'
                  : decodeXml(raw ?? '');
          cells[column(/\br="([A-Z]+)/.exec(attrs)?.[1] ?? String.fromCharCode(65 + cells.length))] = value;
        }
        return Array.from(cells, (v) => csvValue(v ?? '')).join(',');
      });
      return `### Sheet: ${name}\n${rows.filter((r) => r.replace(/,/g, '') !== '').join('\n')}`;
    })
    .join('\n\n');
}

function pptxText(entries: ZipEntry[]): string {
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => byNumber(a.name, b.name));
  const paragraphs = (xml: string): string => tidy(stripTags(xml.replace(/<a:br\/>/g, '\n').replace(/<\/a:p>/g, '\n')));
  return slides
    .map((slide, i) => {
      const rels = entries.find((e) => e.name === slide.name.replace('slides/', 'slides/_rels/').concat('.rels'));
      const notesTarget = rels && /Target="\.\.\/notesSlides\/([^"]+)"/.exec(rels.read().toString('utf8'))?.[1];
      const notes = notesTarget && entries.find((e) => e.name === `ppt/notesSlides/${notesTarget}`);
      const said = notes ? paragraphs(notes.read().toString('utf8')).replace(/^\d+$/m, '').trim() : '';
      return `### Slide ${i + 1}\n${paragraphs(slide.read().toString('utf8'))}${said ? `\n\nSpeaker notes: ${said}` : ''}`;
    })
    .join('\n\n');
}

function vsdxText(entries: ZipEntry[]): string {
  const names = [
    ...(
      entries
        .find((e) => e.name === 'visio/pages/pages.xml')
        ?.read()
        .toString('utf8') ?? ''
    ).matchAll(/<Page\b[^>]*\bName="([^"]*)"/g),
  ].map((m) => decodeXml(m[1]));
  const pages = entries
    .filter((e) => /^visio\/pages\/page\d+\.xml$/.test(e.name))
    .sort((a, b) => byNumber(a.name, b.name));
  return pages
    .map((page, i) => {
      const texts = [
        ...page
          .read()
          .toString('utf8')
          .matchAll(/<Text>([\s\S]*?)<\/Text>/g),
      ].map((m) => stripTags(m[1]));
      return `### Page: ${names[i] ?? i + 1}\n${unique(texts)
        .map((t) => `- ${t}`)
        .join('\n')}`;
    })
    .join('\n\n');
}

function odfText(xml: string): string {
  let slide = 0;
  return tidy(
    stripTags(
      xml
        .replace(/<draw:page\b/g, () => `\n### Slide ${++slide}\n<draw:page`)
        .replace(/<table:table\s[^>]*table:name="([^"]*)"[^>]*>/g, '\n### Sheet: $1\n')
        .replace(/<text:s\b[^>]*\/>/g, ' ')
        .replace(/<text:tab\/>/g, '\t')
        .replace(/<text:line-break\/>/g, '\n')
        .replace(/<\/text:(p|h)>/g, '\n')
        .replace(/<\/table:table-cell>/g, ' | ')
        .replace(/<\/table:table-row>/g, '\n'),
    ).replace(/ \| \n/g, '\n'),
  );
}

function labelled(kind: string, labels: string[]): string {
  return labels.length
    ? `A ${kind} diagram. Its shapes and labels, in the order the diagram holds them:\n${labels.map((l) => `- ${l}`).join('\n')}`
    : `A ${kind} diagram with no text in it.`;
}

/**
 * The labels of a Gliffy diagram's source, in order and once each, or undefined when it is not JSON.
 *
 * @param source The diagram's JSON, as Confluence stores it beside the page.
 */
export function gliffyLabels(source: string): string[] | undefined {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    // Not the JSON a Gliffy diagram is kept as; the caller names it as unread.
    return undefined;
  }
  const labels: string[] = [];
  const walk = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (key !== 'html' && key !== 'text') return;
      labels.push(stripTags(value.replace(/<\/p>|<br\s*\/?>/gi, ' ')).replace(/\s+/g, ' '));
    } else if (Array.isArray(value)) value.forEach((v) => walk(v));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(json);
  return unique(labels);
}

function gliffyText(source: string): DocumentText {
  const labels = gliffyLabels(source);
  return labels === undefined
    ? { why: 'a Gliffy diagram whose source could not be read' }
    : { text: labelled('Gliffy', labels), as: 'Gliffy' };
}

/** A draw.io page's diagram, which draw.io often keeps deflated, base64-encoded and URI-encoded. */
function drawioModel(content: string): string {
  if (content.includes('<mxGraphModel')) return content;
  const packed = Buffer.from(content.trim(), 'base64');
  return decodeURIComponent(zlib.inflateRawSync(packed, { maxOutputLength: 20 * 1024 * 1024 }).toString('utf8'));
}

function drawioText(source: string): DocumentText {
  const pages = [...source.matchAll(/<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g)];
  const models = pages.length
    ? pages.map((p) => ({ name: /\bname="([^"]*)"/.exec(p[1])?.[1], xml: drawioModel(p[2]) }))
    : [{ name: undefined, xml: source }];
  if (!models.some((m) => m.xml.includes('<mxGraphModel')))
    return { why: 'a draw.io diagram whose source could not be read' };
  const text = models
    .map(({ name, xml }) => {
      const labels = [...xml.matchAll(/<(?:mxCell|UserObject|object)\b[^>]*?\b(?:value|label)="([^"]*)"/g)].map((m) =>
        stripTags(decodeXml(m[1]).replace(/<\/(p|div)>|<br\s*\/?>/gi, ' ')).replace(/\s+/g, ' '),
      );
      return `${models.length > 1 && name ? `### Page: ${decodeXml(name)}\n` : ''}${labelled('draw.io', unique(labels))}`;
    })
    .join('\n\n');
  return { text, as: 'draw.io' };
}

function svgText(source: string): string {
  const parts = [...source.matchAll(/<(title|desc|text)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) =>
    stripTags(m[2]).replace(/\s+/g, ' '),
  );
  return labelled('SVG', unique(parts)).replace('A SVG diagram', 'An SVG image');
}

function bpmnText(source: string): string {
  const named = [...source.matchAll(/<(?:\w+:)?(\w+)\b[^>]*?\bname="([^"]+)"/g)]
    .filter((m) => m[1] !== 'definitions')
    .map((m) => `${m[1]}: ${decodeXml(m[2])}`);
  return labelled('BPMN', unique(named));
}

/** What one RTF control word or escape at the start of `rest` stands for, and how long it is. */
function rtfControl(rest: string): { text: string; length: number } {
  const word = /^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\(.)/i.exec(rest);
  if (!word) return { text: '', length: 1 };
  const length = word[0].length;
  if (word[3]) return { text: String.fromCharCode(parseInt(word[3], 16)), length };
  if (word[4]) return { text: /[\\{}]/.test(word[4]) ? word[4] : '', length };
  if (word[1] === 'par' || word[1] === 'line') return { text: '\n', length };
  if (word[1] === 'tab') return { text: '\t', length };
  if (word[1] === 'u' && word[2]) {
    const code = Number(word[2]) < 0 ? Number(word[2]) + 65536 : Number(word[2]);
    // A Unicode escape is followed by a stand-in character for readers that cannot show it.
    return { text: String.fromCharCode(code), length: rest[length] === '?' ? length + 1 : length };
  }
  return { text: '', length };
}

/** RTF's text, without its font, colour and style tables, and with its escapes turned into characters. */
function rtfText(source: string): string {
  const SKIP = /^\{\\(\*|fonttbl|colortbl|stylesheet|info|pict|header|footer|listtable|listoverridetable)/;
  let out = '';
  let depth = 0;
  let skipFrom = -1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      if (skipFrom < 0 && SKIP.test(source.slice(i, i + 22))) skipFrom = depth;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === skipFrom) skipFrom = -1;
    } else if (skipFrom >= 0) continue;
    else if (ch === '\\') {
      const control = rtfControl(source.slice(i, i + 40));
      out += control.text;
      i += control.length - 1;
    } else if (ch !== '\r' && ch !== '\n') out += ch;
  }
  return tidy(out);
}

const quotedPrintable = (text: string): string =>
  Buffer.from(
    text
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  ).toString('utf8');

/** One part of a message, its headers and its body decoded, choosing plain text inside a multipart one. */
function messagePart(raw: string): { headers: Record<string, string>; body: string } {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  const type = headers['content-type'] ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    const parts = body.split(`--${boundary}`).slice(1, -1).map(messagePart);
    const plain = parts.find((p) => /^text\/plain/i.test(p.headers['content-type'] ?? 'text/plain'));
    const html = parts.find((p) => /^text\/html/i.test(p.headers['content-type'] ?? ''));
    const nested = parts.find((p) => p.body && /^multipart\//i.test(p.headers['content-type'] ?? ''));
    return { headers, body: (plain ?? html ?? nested ?? { body: '' }).body };
  }
  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  const decoded =
    encoding === 'base64'
      ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
      : encoding === 'quoted-printable'
        ? quotedPrintable(body)
        : body;
  return { headers, body: /^text\/html/i.test(type) ? storageToBody(decoded) : decoded };
}

function emlText(source: string): string {
  const { headers, body } = messagePart(source);
  const lines = ['from', 'to', 'cc', 'date', 'subject']
    .filter((h) => headers[h])
    .map((h) => `${h[0].toUpperCase()}${h.slice(1)}: ${headers[h]}`);
  return tidy(`${lines.join('\n')}\n\n${body}`);
}

const EVENT_FIELDS: Record<string, string> = {
  DTSTART: 'Starts',
  DTEND: 'Ends',
  LOCATION: 'Location',
  ORGANIZER: 'Organizer',
};

function icsText(source: string): string {
  const unfolded = source.replace(/\r?\n[ \t]/g, '');
  const value = (block: string, key: string): string | undefined =>
    new RegExp(`^${key}(?:;[^:\\n]*)?:(.*)$`, 'm')
      .exec(block)?.[1]
      ?.replace(/\\n/gi, '\n')
      .replace(/\\([,;\\])/g, '$1')
      .trim();
  const events = [...unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((m) =>
    [
      `### ${value(m[1], 'SUMMARY') ?? 'Event'}`,
      Object.entries(EVENT_FIELDS)
        .flatMap(([key, label]) => {
          const v = value(m[1], key);
          return v ? [`${label}: ${v}`] : [];
        })
        .join('\n'),
      value(m[1], 'DESCRIPTION') ?? '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return events.length ? events.join('\n\n') : 'A calendar file with no events.';
}

function notebookText(source: string): string {
  const notebook = JSON.parse(source) as {
    cells?: Array<{ cell_type?: string; source?: string | string[] }>;
    metadata?: { language_info?: { name?: string } };
  };
  const language = notebook.metadata?.language_info?.name ?? '';
  return (notebook.cells ?? [])
    .map((cell) => {
      const text = (Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '')).trim();
      if (!text) return '';
      return cell.cell_type === 'code' ? `\`\`\`${language}\n${text}\n\`\`\`` : text;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** An archive's file list, and the text of each file inside it the app reads, archives aside. */
function zipText(entries: ZipEntry[]): string {
  const files = entries.filter((e) => !e.name.endsWith('/'));
  const inside = files.flatMap((e) => {
    if (path.extname(e.name).toLowerCase() === '.zip' || !readsAsText(e.name)) return [];
    const read = documentText(e.name, '', e.read());
    return 'text' in read ? [`### ${e.name}\n${read.text}`] : [];
  });
  return [`Files in the archive:\n${files.map((e) => `- ${e.name}`).join('\n')}`, ...inside].join('\n\n');
}
