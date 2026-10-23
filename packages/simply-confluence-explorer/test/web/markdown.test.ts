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

// Page text and AI answers are rendered on the origin that can push pages, so what a page's author or
// a model writes must never become markup or script there.

import { describe, expect, it } from 'vitest';
import { bodyOf, partPictures, renderMarkdown } from '../../web/src/support/markdown.js';

describe('rendering Markdown', () => {
  it('shows raw HTML in a page as text', () => {
    const html = renderMarkdown('Before\n\n<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>');
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it("shows Confluence's info and warning panels as callouts, and other quotes as quotes", () => {
    const info = renderMarkdown('> **info: Heads up**\n> Info panels become alerts.');
    expect(info).toContain('class="callout callout-info"');
    expect(info).toContain('<strong>Heads up</strong> Info panels become alerts.');
    expect(info).not.toContain('info:');
    expect(renderMarkdown('> **warning: Careful**\n> Not on Fridays.')).toContain('callout-warning');
    expect(renderMarkdown('> **note**\n> No title.')).toMatch(/callout-info[\s\S]*<p>No title\./);
    expect(renderMarkdown('> Just a quote.')).toContain('<blockquote>');
  });

  it("keeps markup in a panel's title as text", () => {
    const html = renderMarkdown('> **info: <img src=x onerror="alert(1)">**\n> Body.');
    expect(html).toContain('callout-info');
    expect(html).not.toMatch(/<img/);
  });

  it('shows inline HTML as text too', () => {
    expect(renderMarkdown('a <b onclick="x()">bold</b> word')).not.toContain('<b ');
  });

  it('drops a link or image that would run script, and keeps ordinary ones', () => {
    const html = renderMarkdown(
      '[bad](javascript:alert(1)) [data](data:text/html,x) ![img](javascript:x) [web](https://example.com/a) [here](#steps) [page](/api/pages/1)',
    );
    expect(html).not.toMatch(/javascript:|data:text/);
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('href="#steps"');
    expect(html).toContain('href="/api/pages/1"');
  });

  it('still renders Markdown itself', () => {
    expect(renderMarkdown('# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |')).toMatch(/<h1>Title<\/h1>[\s\S]*<table>/);
  });

  it('leaves the frontmatter block out of what a page says', () => {
    expect(bodyOf('---\ntitle: X\npageId: "1"\n---\n\n# X\n\nBody')).toBe('# X\n\nBody');
    expect(bodyOf('# No frontmatter\n\n---\n\nrule')).toBe('# No frontmatter\n\n---\n\nrule');
  });
});

describe("an edit's pictures", () => {
  const pictures = partPictures('PLAT', '42', [{ n: 1 }, { n: 2, picture: 0 }]);

  it('are served from the synced page, by their place in its attachments', () => {
    expect(pictures).toEqual({ 2: '/api/space-cache/PLAT/pages/42/attachments/0' });
  });

  it('show an image or diagram where its marker was only a chip, and leave other markers as chips', () => {
    const html = renderMarkdown('See ⟦2 image: loop"x.png⟧ and ⟦1 toc⟧.', pictures);
    expect(html).toContain('<img src="/api/space-cache/PLAT/pages/42/attachments/0" alt="image: loop&quot;x.png"');
    expect(html).toMatch(/<span class="part-chip"[^>]*>1 toc<\/span>/);
    expect(html.match(/<img/g)).toHaveLength(1);
  });
});
