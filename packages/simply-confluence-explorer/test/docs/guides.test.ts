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

// The user guides ship in the package's docs/ folder, and the SimplySF documentation site builds its
// pages from them as published (ADR-042). The site needs a title and description on every page, and
// copies the folder as it is, so a broken image or a link to a guide that does not exist reaches
// readers unless it is caught here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = fileURLToPath(new URL('../../', import.meta.url));
const docs = path.join(pkg, 'docs');
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const pages = [
  path.join(docs, 'getting-started.md'),
  ...fs
    .readdirSync(path.join(docs, 'guides'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(docs, 'guides', f)),
];
const guideSlugs = new Set(
  fs
    .readdirSync(path.join(docs, 'guides'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, '')),
);
const images = fs.readdirSync(path.join(docs, 'images'));
const imagesIn = (file: string): string[] =>
  [...read(file).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => path.resolve(path.dirname(file), m[1]));

describe('the user guides', () => {
  it('give every page the title and description the documentation site needs', () => {
    expect(pages.length).toBeGreaterThanOrEqual(8);
    for (const page of pages) {
      const front = /^---\n([\s\S]*?)\n---\n/.exec(read(page))?.[1] ?? '';
      expect(front, `${path.basename(page)} has no title`).toMatch(/^title: .+$/m);
      expect(front, `${path.basename(page)} has no description`).toMatch(/^description: .+$/m);
    }
  });

  it('show only images that exist, and use every image in docs/images', () => {
    // The root README shows the overview in the reader's own theme, through a <picture> element.
    const readme = read(path.join(pkg, '../../README.md'));
    const used = new Set([...readme.matchAll(/(?:src|srcset)="[^"]*\/docs\/images\/([^"]+)"/g)].map((m) => m[1]));
    for (const page of pages) {
      for (const image of imagesIn(page)) {
        expect(fs.existsSync(image), `${path.basename(page)} shows ${image}, which does not exist`).toBe(true);
        used.add(path.basename(image));
      }
    }
    for (const image of images) expect(used.has(image), `docs/images/${image} is not shown by any guide`).toBe(true);
  });

  it('link only to guides that exist', () => {
    for (const page of pages) {
      for (const m of read(page).matchAll(/\]\(\/guides\/([\w-]+)\/\)/g)) {
        expect(guideSlugs.has(m[1]), `${path.basename(page)} links to /guides/${m[1]}/`).toBe(true);
      }
    }
  });

  it('are linked from both READMEs by paths that exist', () => {
    const readmes = [path.join(pkg, 'README.md'), path.join(pkg, '../../README.md')];
    for (const readme of readmes) {
      const links = [...read(readme).matchAll(/\]\(([^)]*docs\/[^)]+\.(?:md|webp))\)/g)].map((m) => m[1]);
      expect(links.length, `${readme} links to no guide`).toBeGreaterThanOrEqual(9);
      for (const link of links) {
        expect(fs.existsSync(path.resolve(path.dirname(readme), link)), `${readme} links to ${link}`).toBe(true);
      }
    }
  });
});
