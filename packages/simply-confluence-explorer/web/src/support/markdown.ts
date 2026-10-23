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

import { Marked, type Token } from 'marked';

// Page text comes from whoever wrote the page in Confluence, and AI answers from a model. Both are
// shown on the origin that can push pages, so raw HTML in them is shown as text, never as markup,
// and a link may only lead to the web, mail, or within the app. The server's Content-Security-Policy
// blocks inline script as well; this keeps the markup itself from carrying any.

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SAFE_HREF = /^(https?:|mailto:|#|\/(?!\/)|\.{0,2}\/|[^:]*$)/i;

// Confluence's info, tip, note, warning and panel macros arrive as a quote that opens with the
// macro's name in bold ("**info: Heads up**"), and are shown as a tinted callout with an icon.
const CALLOUT = /^<p><strong>(info|tip|note|warning|panel)(?:: ([^<]*))?<\/strong>\s*/;
const ICON = (path: string): string =>
  `<svg class="callout-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const INFO = ICON('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>');
const WARNING = ICON(
  '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
);

const marked = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => escape(text),
    blockquote({ tokens }) {
      const inner = this.parser.parse(tokens);
      const m = CALLOUT.exec(inner);
      if (!m) return `<blockquote>\n${inner}</blockquote>\n`;
      const warning = m[1] === 'warning';
      const title = m[2] ? `<strong>${m[2]}</strong> ` : '';
      return `<div class="callout callout-${warning ? 'warning' : 'info'}">${warning ? WARNING : INFO}<div class="callout-body"><p>${title}${inner.slice(m[0].length)}</div></div>\n`;
    },
  },
  walkTokens: (token: Token) => {
    if ((token.type === 'link' || token.type === 'image') && !SAFE_HREF.test(token.href.trim())) token.href = '';
  },
});

/** The address of each part's picture, by its marker's number (ADR-068). */
export type Pictures = Record<number, string>;

/**
 * Where the pictures of an edit's parts are served from: a synced page's image attachments and its
 * diagrams' previews, by their place in the page's list.
 *
 * @param spaceKey The page's space.
 * @param pageId The page.
 * @param parts The edit's parts, each with the place of its picture when it has one.
 */
export function partPictures(
  spaceKey: string,
  pageId: string,
  parts: ReadonlyArray<{ n: number; picture?: number }> = [],
): Pictures {
  return Object.fromEntries(
    parts.flatMap((p) =>
      p.picture === undefined
        ? []
        : [
            [
              p.n,
              `/api/space-cache/${encodeURIComponent(spaceKey)}/pages/${encodeURIComponent(pageId)}/attachments/${p.picture}`,
            ],
          ],
    ),
  );
}

/** A part shown as its picture, with its marker's words beneath, or as those words alone. */
export function partHtml(n: number, label: string, pictures: Pictures = {}): string {
  const chip = `<span class="part-chip" title="A part of the page that is kept as it is">${n} ${label}</span>`;
  const src = pictures[n];
  return src
    ? `<span class="part-picture"><img src="${escape(src)}" alt="${label.replace(/"/g, '&quot;')}" loading="lazy" />${chip}</span>`
    : chip;
}

/**
 * Renders Markdown for display, with raw HTML escaped and unsafe link targets removed. A marker for
 * a part of the page is shown as a chip, or as its picture when it has one.
 *
 * @param markdown The Markdown to render.
 * @param pictures The parts' pictures, by marker number.
 */
export function renderMarkdown(markdown: string, pictures: Pictures = {}): string {
  return marked
    .parse(markdown, { async: false })
    .replace(/⟦(\/?)(\d+)(?: ([^⟧<\n]*))?⟧/g, (_m, close: string, n: string, label?: string) =>
      close
        ? `<span class="part-chip" title="A part of the page that is kept as it is">end of ${n}</span>`
        : partHtml(Number(n), label ?? '', pictures),
    );
}

export type TextPiece = { text: string; part?: boolean };

/**
 * Splits text at its markers for parts of a page, such as `⟦3 toc⟧`, so each can be shown as a
 * part rather than as characters (ADR-058).
 *
 * @param text Text that may hold markers.
 */
export function partPieces(text: string): TextPiece[] {
  return text
    .split(/(⟦\/?\d+(?: [^⟧\n]*)?⟧)/)
    .flatMap((t, i) => (t === '' ? [] : [i % 2 ? { text: t, part: true } : { text: t }]));
}

/**
 * A page's Markdown without the frontmatter block the app writes at its top, which is metadata for
 * files on disk rather than part of what the page says.
 *
 * @param markdown A page's Markdown, as the server sends it.
 */
export function bodyOf(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
}
