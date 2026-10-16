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

// Promises the frontend makes in every component, held here because neither the type check nor the
// build sees them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const web = fileURLToPath(new URL('../../web/src/', import.meta.url));
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = (ext: RegExp): Array<{ name: string; text: string }> =>
  files(web)
    .filter((f) => ext.test(f))
    .map((f) => ({ name: path.relative(web, f), text: fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') }));
const components = (): Array<{ name: string; text: string }> => sources(/\.svelte$/);

// A class used only to find an element, or styled only through its parent, has no rule of its own.
const HOOKS = new Set(['branch-findings', 'new-page-check', 'new-page-done']);

/**
 * The class names a component can set: plain words in a class attribute, and quoted words or object
 * keys inside a class expression. A word joined to an expression (`toast-{t.kind}`) names a family
 * whose members cannot be listed, so it is skipped.
 */
function classNames(source: string): string[] {
  const names: string[] = [];
  const words = (text: string): string[] => text.split(/\s+/).filter((w) => /^[a-zA-Z][\w-]*$/.test(w));
  const attrs = /\b(?:class|extraClass|bodyClass|buttonClass|size)=("([^"]*)"|\{((?:[^{}]|\{[^{}]*\})*)\})/g;
  for (const m of source.matchAll(attrs)) {
    if (m[2] !== undefined) names.push(...words(m[2].replace(/\S*\{[^}]*\}\S*/g, ' ')));
    else {
      for (const q of m[3].matchAll(/'([^']*)'/g)) names.push(...words(q[1]));
      for (const k of m[3].matchAll(/[{,]\s*([a-zA-Z][\w-]*)\s*:/g)) names.push(k[1]);
    }
  }
  return names;
}

describe('the frontend', () => {
  it('gives every class it sets a CSS rule, or lists it as a hook', () => {
    const css = sources(/\.css$/)
      .map((f) => f.text)
      .join('\n');
    const defined = new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));
    const missing = components().flatMap(({ name, text }) =>
      classNames(text)
        .filter((c) => !defined.has(c) && !HOOKS.has(c))
        .map((c) => `${c} (${name})`),
    );
    // A class with no rule renders as nothing: a dialog given an undefined class has no background.
    expect(missing, 'add a CSS rule, or add the name to HOOKS if it is styled only through its parent').toEqual([]);
  });

  it('still uses every listed hook, so the list does not outlive its names', () => {
    const all = components()
      .map((c) => classNames(c.text))
      .flat();
    for (const hook of HOOKS) expect(all, `${hook} is no longer used`).toContain(hook);
  });

  it('takes its colours from the theme, so the light theme has no dark patches', () => {
    const fixed = components().flatMap(({ name, text }) =>
      [...text.matchAll(/(#[0-9a-fA-F]{3,8}\b|rgba?\(|['"](?:white|black)['"])/g)]
        .filter((m) => !/&#\d/.test(text.slice(m.index - 1, m.index + 4)))
        .map((m) => `${m[1]} (${name})`),
    );
    expect(fixed, 'use a variable from the :root and [data-theme=light] blocks in app.css').toEqual([]);
  });

  it('reports an outcome as a toast or inline, never with alert() or confirm(), which block the page', () => {
    const blocking = sources(/\.(svelte|ts)$/).flatMap(({ name, text }) =>
      [...text.matchAll(/\b(?:window\.)?(alert|confirm|prompt)\(/g)].map((m) => `${m[1]}() (${name})`),
    );
    expect(blocking, 'use toast() from support/toast.svelte.ts, or ConfirmDialog for a question').toEqual([]);
  });

  it('renders HTML only through Markdown.svelte, which escapes what a page or a model wrote', () => {
    const raw = components()
      .filter((c) => c.text.includes('{@html'))
      .map((c) => c.name);
    expect(raw).toEqual([path.join('components', 'ui', 'Markdown.svelte')]);
  });

  it('imports server code for its types only, so none of it reaches the browser bundle', () => {
    const imports = sources(/\.(svelte|ts)$/).flatMap(({ name, text }) =>
      [...text.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+'((?:\.\.\/)+src\/[^']+)'/gm)]
        .filter((m) => !m[1])
        .map((m) => `${m[2]} (${name})`),
    );
    expect(imports).toEqual([]);
  });
});
