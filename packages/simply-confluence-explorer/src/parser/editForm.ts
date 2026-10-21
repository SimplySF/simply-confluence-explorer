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
import { HttpError } from '../http/router.js';
import { errorMessage } from '../util/errors.js';
import { missingParts } from './convert.js';

// A page is edited as Markdown, and Markdown has no form for a macro, an image, a link to another
// page, a mention, a task list or a layout. The edit form stands each of them in the text as a
// numbered marker and keeps its storage aside, so writing the page puts each one back exactly. A
// block the edit leaves alone is written back byte for byte, so formatting Markdown cannot carry
// survives too (ADR-058, design doc 0009).

/** A part of the page the text stands in for: kept whole, or a container whose insides are text. */
export type Part =
  | { n: number; label: string; kind: 'inline' | 'block'; xml: string }
  | { n: number; label: string; kind: 'container'; open: string; close: string };

/** A stretch of the page as text, with the storage it came from. */
export type Unit = {
  md: string;
  xml: string;
  /** The parts whose storage this unit holds. */
  parts: number[];
  /** Formatting this block holds that its text cannot, lost if the block is changed. */
  drops: string[];
};

export type EditForm = { markdown: string; units: Unit[]; parts: Part[] };

/** A marker in the text: `⟦3 toc⟧`, or `⟦/7⟧` closing a container. */
export const MARKER = /⟦(\/?)(\d+)(?: [^⟧\n]*)?⟧/g;
/** A marker that is the whole of a line. */
export const LINE_MARKER = /^⟦(\/?)(\d+)(?: [^⟧\n]*)?⟧$/;

type Node = {
  tag: string;
  attrs: string;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  kids: Node[];
};

const TAG =
  /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const VOID = new Set(['br', 'hr', 'img', 'col', 'meta', 'link', 'input', 'wbr']);

/** A tolerant parse of storage into elements with their offsets; text lies in the gaps between them. */
function parse(xml: string): Node[] {
  const root: Node = { tag: '', attrs: '', start: 0, openEnd: 0, closeStart: xml.length, end: xml.length, kids: [] };
  const stack = [root];
  for (const m of xml.matchAll(TAG)) {
    const at = m.index;
    const after = at + m[0].length;
    if (!m[2]) {
      stack
        .at(-1)!
        .kids.push({ tag: '#cdata', attrs: '', start: at, openEnd: after, closeStart: after, end: after, kids: [] });
      continue;
    }
    if (m[1]) {
      const i = stack.findLastIndex((n) => n.tag === m[2]);
      // A stray closing tag stays in the text around it, which is sliced by offset and so kept.
      if (i <= 0) continue;
      while (stack.length > i + 1) {
        const open = stack.pop()!;
        open.closeStart = open.end = at;
      }
      const node = stack.pop()!;
      node.closeStart = at;
      node.end = after;
      continue;
    }
    const node: Node = { tag: m[2], attrs: m[3], start: at, openEnd: after, closeStart: after, end: after, kids: [] };
    stack.at(-1)!.kids.push(node);
    if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(node);
  }
  for (const open of stack.slice(1)) open.closeStart = open.end = xml.length;
  return root.kids;
}

const attr = (node: Node, name: string): string | undefined =>
  new RegExp(`${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*"([^"]*)"`).exec(node.attrs)?.[1];
const inner = (xml: string, node: Node): string => xml.slice(node.openEnd, node.closeStart);
const textOf = (xml: string): string =>
  xml
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const child = (node: Node, tag: string): Node | undefined => node.kids.find((k) => k.tag === tag);
const param = (xml: string, node: Node, name: string): string | undefined => {
  const p = node.kids.find((k) => k.tag === 'ac:parameter' && attr(k, 'ac:name') === name);
  return p ? textOf(inner(xml, p)) : undefined;
};

/** Words a person can read a marker by; the number alone is what the marker means. */
function clean(label: string): string {
  const words = label
    .replace(/[⟦⟧[\]*_`<>&#|\\~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return words.length > 40 ? `${words.slice(0, 39).trimEnd()}…` : words;
}

function linkLabel(body: string, anchor: string | undefined): string {
  if (/<ri:user\b/.test(body)) return 'mention';
  const shown = textOf(body.replace(/<ri:[^>]*>/g, ''));
  if (shown !== '') return clean(`link: ${shown}`);
  const target =
    /ri:content-title="([^"]*)"/.exec(body)?.[1] ??
    /ri:filename="([^"]*)"/.exec(body)?.[1] ??
    (anchor === undefined ? 'page' : `#${anchor}`);
  return clean(`link: ${target}`);
}

function labelOf(xml: string, node: Node): string {
  switch (node.tag) {
    case 'ac:structured-macro': {
      const name = attr(node, 'ac:name') ?? 'macro';
      const detail = param(xml, node, 'title') ?? param(xml, node, 'key');
      return clean(detail ? `${name}: ${detail}` : name);
    }
    case 'ac:image': {
      const file = /ri:(?:filename|value)="([^"]*)"/.exec(inner(xml, node))?.[1];
      return clean(file === undefined ? 'image' : `image: ${file}`);
    }
    case 'ac:link':
      return linkLabel(inner(xml, node), attr(node, 'ac:anchor'));
    case 'ac:emoticon':
      return clean(`emoticon: ${attr(node, 'ac:name') ?? ''}`);
    case 'ac:inline-comment-marker':
      return clean(`commented text: ${textOf(inner(xml, node))}`);
    case 'ac:task-list':
      return `task list: ${node.kids.filter((k) => k.tag === 'ac:task').length} tasks`;
    case 'time':
      return clean(`date: ${attr(node, 'datetime') ?? ''}`);
    default:
      return `${WHOLE_NAMES[node.tag.replace(/^h[1-6]$/, 'h')] ?? node.tag.replace(/^ac:/, '')}, kept as it is`;
  }
}

const WHOLE_NAMES: Record<string, string> = {
  p: 'paragraph',
  h: 'heading',
  ul: 'list',
  ol: 'list',
  table: 'table',
  blockquote: 'quote',
  'ac:structured-macro': 'macro',
  'ac:adf-extension': 'extension',
};

/** Parts that sit inside a line of text. */
const INLINE_PARTS = new Set([
  'ac:link',
  'ac:image',
  'ac:emoticon',
  'ac:inline-comment-marker',
  'time',
  'ac:placeholder',
]);
/** Parts that are blocks of their own. */
const BLOCK_PARTS = new Set(['ac:structured-macro', 'ac:task-list', 'ac:adf-extension', 'ac:layout']);
const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'blockquote',
  'pre',
  'hr',
  'div',
  'section',
  'ac:structured-macro',
  'ac:task-list',
  'ac:adf-extension',
  'ac:layout',
  'ac:layout-section',
  'ac:layout-cell',
]);

/**
 * What a block's text cannot carry, found by writing the text back: a change to `structure` would
 * change the block itself, so the block is kept whole; `format` is named on a change that touches it.
 */
const STRUCTURE: RegExp[] = [/<table\b/g, /<tr\b/g, /<t[dh]\b/g, /<li\b/g, /<h[1-6]\b/g, /\b(?:colspan|rowspan)=/g];
const FORMAT: Array<[RegExp, string]> = [
  [/<span\b[^>]*\bstyle=/g, 'text colour or highlighting'],
  [/<u>/g, 'underlining'],
  [/<su[bp]>/g, 'subscript or superscript'],
  [/<t[dh]\b[^>]*\b(?:class|style|data-highlight-colour)=/g, 'table cell colours'],
  [/<(?:table|col)\b[^>]*\b(?:class|style|width|data-layout)=/g, 'table widths'],
  [/<(?:p|h[1-6])\b[^>]*\bstyle=/g, 'text alignment'],
];
const count = (re: RegExp, s: string): number => s.match(re)?.length ?? 0;
const isCode = (xml: string, node: Node): boolean =>
  node.tag === 'ac:structured-macro' &&
  attr(node, 'ac:name') === 'code' &&
  node.kids.every((k) => k.tag !== 'ac:parameter' || attr(k, 'ac:name') === 'language') &&
  !!child(node, 'ac:plain-text-body') &&
  !xml.includes('⟦');

type Group = { start: number; nodes: Node[]; block: boolean };

function addInline(groups: Group[], start: number, node?: Node): void {
  const last = groups.at(-1);
  if (last && !last.block) {
    if (node) last.nodes.push(node);
  } else groups.push({ start, nodes: node ? [node] : [], block: false });
}

/** A macro written inside a line, such as a status, rather than as a block of its own. */
const inlineMacro = (node: Node): boolean =>
  /^(status|anchor|jira)$/.test(attr(node, 'ac:name') ?? '') && !child(node, 'ac:rich-text-body');

function layoutLabel(node: Node): string {
  if (node.tag === 'ac:layout') return 'layout';
  const type = attr(node, 'ac:type');
  if (node.tag === 'ac:layout-section') return clean(type === undefined ? 'layout section' : `layout section: ${type}`);
  return 'column';
}

class Builder {
  public readonly parts: Part[] = [];

  public constructor(private readonly xml: string) {}

  /** The units for the siblings between two offsets, covering every byte between them. */
  public units(nodes: Node[], from: number, to: number): Unit[] {
    const groups: Group[] = [];
    let cursor = from;
    for (const node of nodes) {
      if (node.start > cursor && this.xml.slice(cursor, node.start).trim() !== '') addInline(groups, cursor);
      if (BLOCK_TAGS.has(node.tag) && !(node.tag === 'ac:structured-macro' && inlineMacro(node)))
        groups.push({ start: groups.length === 0 ? from : node.start, nodes: [node], block: true });
      else addInline(groups, node.start, node);
      cursor = node.end;
    }
    if (cursor < to && this.xml.slice(cursor, to).trim() !== '') addInline(groups, cursor);
    if (groups.length > 0) groups[0].start = from;
    return groups.flatMap((g, i) => this.group(g, i + 1 < groups.length ? groups[i + 1].start : to));
  }

  private group(g: Group, end: number): Unit[] {
    const node = g.nodes[0];
    const slice = this.xml.slice(g.start, end);
    if (g.block && node) {
      const name = attr(node, 'ac:name');
      const body = node.tag === 'ac:structured-macro' ? child(node, 'ac:rich-text-body') : undefined;
      if (node.tag.startsWith('ac:layout')) return this.container(node, node, g.start, end, layoutLabel(node));
      if (body && name !== 'code') return this.container(node, body, g.start, end, labelOf(this.xml, node));
      if (BLOCK_PARTS.has(node.tag) && !isCode(this.xml.slice(node.start, node.end), node))
        return [this.whole(slice, labelOf(this.xml, node))];
    }
    return [this.text(slice, g.start, g.nodes)];
  }

  private container(node: Node, body: Node, start: number, end: number, label: string): Unit[] {
    const n = this.parts.length + 1;
    const open = this.xml.slice(start, body.openEnd);
    const close = this.xml.slice(body.closeStart, end);
    this.parts.push({ n, label, kind: 'container', open, close });
    if (node.tag === 'ac:layout-section') {
      const cells = node.kids.filter((k) => k.tag === 'ac:layout-cell');
      cells.forEach((c, i) => (c.attrs += ` data-column="${i + 1} of ${cells.length}"`));
    }
    if (node.tag === 'ac:layout-cell') {
      const column = /data-column="([^"]*)"/.exec(node.attrs)?.[1];
      if (column) (this.parts.at(-1) as { label: string }).label = `column ${column}`;
    }
    const kids = this.units(body.kids, body.openEnd, body.closeStart);
    return [
      { md: `⟦${n} ${this.parts[n - 1].label}⟧`, xml: open, parts: [n], drops: [] },
      ...kids,
      { md: `⟦/${n}⟧`, xml: close, parts: [], drops: [] },
    ];
  }

  private whole(xml: string, label: string): Unit {
    const n = this.parts.length + 1;
    this.parts.push({ n, label, kind: 'block', xml });
    return { md: `⟦${n} ${label}⟧`, xml, parts: [n], drops: [] };
  }

  /** A block of text, its inline parts as markers; kept whole when its text cannot be written back. */
  private text(xml: string, offset: number, nodes: Node[]): Unit {
    const first = this.parts.length;
    const leaves: Array<{ node: Node; block: boolean }> = [];
    const walk = (list: Node[]): void => {
      for (const node of list) {
        if (INLINE_PARTS.has(node.tag) || BLOCK_PARTS.has(node.tag))
          leaves.push({ node, block: !INLINE_PARTS.has(node.tag) && !inlineMacro(node) });
        else walk(node.kids);
      }
    };
    walk(nodes);
    const keepWhole = (): Unit => {
      this.parts.length = first;
      return this.whole(
        xml,
        labelOf(this.xml, nodes.find((n) => n.tag !== '#cdata') ?? nodes[0] ?? ({ tag: 'text' } as Node)),
      );
    };
    if (leaves.some((l) => l.block && !isCode(this.xml.slice(l.node.start, l.node.end), l.node))) return keepWhole();
    let tokenized = '';
    let at = 0;
    const numbers: number[] = [];
    for (const { node } of leaves.filter((l) => !isCode(this.xml.slice(l.node.start, l.node.end), l.node))) {
      const n = this.parts.length + 1;
      const label = labelOf(this.xml, node);
      this.parts.push({ n, label, kind: 'inline', xml: this.xml.slice(node.start, node.end) });
      numbers.push(n);
      tokenized += `${xml.slice(at, node.start - offset)}⟦${n} ${label}⟧`;
      at = node.end - offset;
    }
    tokenized += xml.slice(at);
    const md = storageToMarkdown(tokenized).trim();
    if (md === '') {
      this.parts.length = first;
      return { md: '', xml, parts: [], drops: [] };
    }
    let back: string;
    try {
      back = markdownToStorage(md);
    } catch {
      // The text cannot be written back at all, so the block is kept exactly as it is.
      return keepWhole();
    }
    const found = [...md.matchAll(MARKER)].map((m) => Number(m[2]));
    if (found.length !== numbers.length || numbers.some((n, i) => found[i] !== n)) return keepWhole();
    if (STRUCTURE.some((re) => count(re, tokenized) !== count(re, back))) return keepWhole();
    const drops = FORMAT.filter(([re]) => count(re, tokenized) > count(re, back)).map(([, what]) => what);
    return { md, xml, parts: numbers, drops };
  }
}

/**
 * The page as text a person and a model can edit, with a marker for every part the text has no
 * form for, and the storage each block came from.
 *
 * @param storageXml The page as Confluence holds it.
 */
export function toEditForm(storageXml: string): EditForm {
  const builder = new Builder(storageXml);
  const raw = builder.units(parse(storageXml), 0, storageXml.length);
  // A block with no text, such as an empty paragraph, travels with the block before it.
  const units: Unit[] = [];
  let carry = '';
  for (const unit of raw) {
    if (unit.md !== '') {
      units.push({ ...unit, xml: carry + unit.xml });
      carry = '';
    } else if (units.length > 0) units.at(-1)!.xml += unit.xml;
    else carry += unit.xml;
  }
  if (carry) units.push({ md: '', xml: carry, parts: [], drops: [] });
  return { markdown: units.map((u) => u.md).join('\n\n'), units, parts: builder.parts };
}

/**
 * Splits text into the blocks a change is made of: paragraphs apart from blank lines, with a code
 * fence kept whole and a marker for a block part always a block of its own.
 *
 * @param markdown The text.
 * @param blockMarker Whether a marker's part is a block, which stands on a line of its own.
 */
export function blocksOf(markdown: string, blockMarker: (n: number) => boolean): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = (): void => {
    const text = current.join('\n').trimEnd();
    if (text.trim() !== '') out.push(text);
    current = [];
  };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const marker = fenced ? null : LINE_MARKER.exec(line.trim());
    if (marker && (marker[1] || blockMarker(Number(marker[2])))) {
      flush();
      current.push(line.trim());
      flush();
    } else if (!fenced && line.trim() === '') flush();
    else current.push(line);
  }
  flush();
  return out;
}

export type DiffOp = { a?: number; b?: number };

/**
 * Pairs two lists of blocks by their longest common run, as same (both), removed (`a` only) or
 * added (`b` only).
 *
 * @param a The blocks before.
 * @param b The blocks after.
 */
export function diffBlocks(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [...a.map((_, i) => ({ a: i })), ...b.map((_, j) => ({ b: j }))];
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ a: i++, b: j++ });
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ a: i++ });
    else ops.push({ b: j++ });
  }
  while (i < n) ops.push({ a: i++ });
  while (j < m) ops.push({ b: j++ });
  return ops;
}

/** The blocks of the edit form's own text, each with the unit it came from. */
export function formBlocks(form: EditForm): { blocks: string[]; unitOf: number[] } {
  const isBlock = blockTest(form);
  const blocks: string[] = [];
  const unitOf: number[] = [];
  form.units.forEach((u, i) => {
    for (const b of blocksOf(u.md, isBlock)) {
      blocks.push(b);
      unitOf.push(i);
    }
  });
  return { blocks, unitOf };
}

const blockTest =
  (form: EditForm) =>
  (n: number): boolean =>
    form.parts[n - 1] !== undefined && form.parts[n - 1].kind !== 'inline';

const refuse = (message: string): never => {
  throw new HttpError(400, message);
};
const named = (p: Part): string => `⟦${p.n} ${p.label}⟧`;

/** Refuses text whose markers name parts the page does not have, repeat one, or pair them wrongly. */
function checkMarkers(form: EditForm, markdown: string): void {
  const seen = new Set<string>();
  const open: Part[] = [];
  for (const m of markdown.matchAll(MARKER)) {
    const part = form.parts[Number(m[2]) - 1];
    if (!part) refuse(`⟦${m[2]}⟧ is not a part of this page, so the text cannot say what goes there. Remove it.`);
    const key = `${m[1]}${part.n}`;
    if (seen.has(key)) refuse(`${named(part)} appears twice; each part of the page can be in one place only.`);
    seen.add(key);
    if (part.kind !== 'container') {
      if (m[1]) refuse(`⟦/${part.n}⟧ closes ${named(part)}, which holds no text.`);
      continue;
    }
    if (!m[1]) open.push(part);
    else if (open.pop() !== part)
      refuse(
        `The markers of ${named(part)} are not paired: its opening and closing markers go around its contents, in order.`,
      );
  }
  for (const part of form.parts)
    if (part.kind === 'container' && seen.has(String(part.n)) !== seen.has(`/${part.n}`))
      refuse(`The markers of ${named(part)} are not paired: keep both, or remove both.`);
}

/** Converts changed text to storage and puts each marked part back where its marker stands. */
function convert(form: EditForm, markdown: string, emitted: Set<number>): string {
  let storage: string;
  try {
    storage = markdownToStorage(markdown);
  } catch (error) {
    return refuse(errorMessage(error));
  }
  const pieces = storage.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/);
  return pieces
    .map((piece, i) => {
      // Code keeps a marker as the characters it is, so the part it names is not put inside code.
      if (i % 2 === 1) return piece;
      return piece
        .replace(/<p>(⟦(\/?)(\d+)[^⟧]*⟧)<\/p>/g, (all, _m, close: string, num: string) => {
          const part = form.parts[Number(num) - 1];
          if (part.kind === 'inline') return all;
          emitted.add(part.n);
          if (part.kind === 'container') return close ? part.close : part.open;
          return part.xml;
        })
        .replace(MARKER, (_m, close: string, num: string) => {
          const part = form.parts[Number(num) - 1];
          if (part.kind !== 'inline')
            refuse(`${named(part)} must be on a line of its own, as it is a block of the page.`);
          emitted.add(part.n);
          return (part as { xml: string }).xml;
        });
    })
    .join('');
}

/**
 * Builds the storage to write from edited text. A block the text leaves as it was is written as
 * Confluence holds it; changed and new text is converted, with each part put back at its marker.
 * Every part of the page must be in the result unless its number is in `removes`, which a caller
 * fills only from changes a person accepted; anything else missing refuses the write.
 *
 * @param form The edit form of the page as Confluence holds it now.
 * @param markdown The edited text, without frontmatter.
 * @param removes The parts a person accepted removing.
 */
export function buildStorage(form: EditForm, markdown: string, removes: number[] = []): string {
  checkMarkers(form, markdown);
  const { blocks: before, unitOf } = formBlocks(form);
  const after = blocksOf(markdown, blockTest(form));
  const ops = diffBlocks(before, after);
  const matched = new Map<number, number>();
  for (const op of ops) if (op.a !== undefined && op.b !== undefined) matched.set(op.a, op.b);
  const first = new Map<number, number>();
  const untouched = form.units.map(() => false);
  unitOf.forEach((u, i) => {
    const b = matched.get(i);
    if (!first.has(u)) {
      first.set(u, i);
      untouched[u] = b !== undefined;
    } else untouched[u] = untouched[u] && b !== undefined && b === matched.get(i - 1)! + 1;
  });
  const emitted = new Set<number>();
  const out: string[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.length > 0) out.push(convert(form, pending.join('\n\n'), emitted));
    pending = [];
  };
  for (const op of ops) {
    if (op.b === undefined) continue;
    const u = op.a === undefined ? -1 : unitOf[op.a];
    if (u >= 0 && untouched[u]) {
      if (first.get(u) === op.a) {
        flush();
        out.push(form.units[u].xml);
        for (const n of form.units[u].parts) emitted.add(n);
      }
    } else pending.push(after[op.b]);
  }
  flush();
  const lost = form.parts.filter((p) => !emitted.has(p.n) && !removes.includes(p.n));
  if (lost.length > 0)
    refuse(
      `This change would remove parts of the page that no accepted change removes: ${lost.map(named).join(', ')}. ` +
        'Nothing was written.',
    );
  const storage = out.join('');
  const removed = form.parts.filter((p) => removes.includes(p.n) && !emitted.has(p.n));
  const missing = missingParts(
    form.units.map((u) => u.xml).join(''),
    storage + removed.map((p) => (p.kind === 'container' ? p.open + p.close : p.xml)).join(''),
  );
  if (missing.length > 0) refuse(`This change would lose ${missing.join(', ')} from the page. Nothing was written.`);
  return storage;
}
