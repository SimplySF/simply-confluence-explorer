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

const marked = new Marked({
  gfm: true,
  renderer: { html: ({ text }) => escape(text) },
  walkTokens: (token: Token) => {
    if ((token.type === 'link' || token.type === 'image') && !SAFE_HREF.test(token.href.trim())) token.href = '';
  },
});

/**
 * Renders Markdown for display, with raw HTML escaped and unsafe link targets removed.
 *
 * @param markdown The Markdown to render.
 */
export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false });
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
