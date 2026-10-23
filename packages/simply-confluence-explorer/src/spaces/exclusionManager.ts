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

import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../util/errors.js';
import { sanitizeFilename, within } from '../util/paths.js';

// A space's `.confluenceignore` lists the pages that must never reach an AI (ADR-018). Each line is
// a page id (`id:1234`), a title, a title pattern with `*`, or a path ending in `/`, which also covers
// every page below it. Lines starting with `#` are comments.

/** A page as far as the rules need it: its id, its title, and the pages above it. */
export type RuleTarget = {
  id?: string;
  title?: string;
  ancestors?: Array<{ id?: string; title?: string }>;
};

const HEADER = [
  '# .confluenceignore',
  '# Pages matching these lines, by id, title or path, are never sent to an AI:',
  '# not for questions, not for improvement proposals, and not for summaries or tags.',
  '#',
];

export class ExclusionManager {
  private readonly spacesDir: string;
  // Rules are read once each time the file changes, not once for every page checked.
  private readonly cache = new Map<string, { mtimeMs: number; patterns: string[] }>();
  // Each page's answer under one set of rules, so a pass over the whole space asks each page once.
  private readonly answers = new Map<string, { rules: string[]; byPage: Map<string, boolean> }>();

  public constructor(
    dataDir: string,
    private readonly log: (message: string) => void,
  ) {
    this.spacesDir = path.join(dataDir, 'spaces');
  }

  public ignoreFilePath(spaceKey: string): string {
    return within(this.spacesDir, sanitizeFilename(spaceKey.trim().toUpperCase()), '.confluenceignore');
  }

  /**
   * Reads a space's rules. A file that exists but cannot be read excludes every page in the space,
   * because rules that cannot be read must fail closed: treating them as empty would send exactly
   * the pages someone meant to keep back.
   */
  public patterns(spaceKey: string): string[] {
    const file = this.ignoreFilePath(spaceKey);
    if (!fs.existsSync(file)) return [];
    try {
      const { mtimeMs } = fs.statSync(file);
      const hit = this.cache.get(file);
      if (hit?.mtimeMs === mtimeMs) return hit.patterns;
      const patterns = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
      this.cache.set(file, { mtimeMs, patterns });
      return patterns;
    } catch (error) {
      this.log(
        `cannot read ${file}: ${errorMessage(error)}; every page in ${spaceKey} is excluded until it can be read`,
      );
      return ['*'];
    }
  }

  public savePatterns(spaceKey: string, patterns: string[]): void {
    const file = this.ignoreFilePath(spaceKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = patterns.map((p) => p.trim()).filter((p) => p.length > 0);
    fs.writeFileSync(file, [...HEADER, ...lines, ''].join('\n'), 'utf8');
    this.cache.delete(file);
  }

  /**
   * Whether any rule in the space matches the page or a page above it: by id, by title, or by the
   * page's path. A rule that excludes a page therefore excludes everything below it too, whichever
   * form the rule takes.
   */
  public isPageExcluded(page: RuleTarget, spaceKey: string): boolean {
    return this.checker(spaceKey)(page);
  }

  /**
   * The space's rules read once, as a check for many pages: a pass over the whole space reads the
   * rules file once rather than once for each page. Each page's answer is kept until the rules
   * change, and a single page checked on its own through `isPageExcluded` reads the file every time,
   * so a rule changed or made unreadable applies at once.
   */
  public checker(spaceKey: string): (page: RuleTarget) => boolean {
    const patterns = this.patterns(spaceKey);
    if (patterns.length === 0) return () => false;
    const key = spaceKey.trim().toUpperCase();
    let kept = this.answers.get(key);
    if (kept?.rules !== patterns) {
      kept = { rules: patterns, byPage: new Map() };
      this.answers.set(key, kept);
    }
    const { byPage } = kept;
    return (page) => {
      const id = [page.id, page.title, ...(page.ancestors ?? []).flatMap((a) => [a.id, a.title])].join('\u0000');
      let excluded = byPage.get(id);
      if (excluded === undefined) {
        excluded = matchesAny(patterns, page);
        byPage.set(id, excluded);
      }
      return excluded;
    };
  }
}

function matchesAny(patterns: string[], page: RuleTarget): boolean {
  const title = page.title ?? '';
  const ids = [page.id, ...(page.ancestors ?? []).map((a) => a.id)].filter((id): id is string => !!id);
  const ancestors = (page.ancestors ?? []).map((a) => a.title ?? '');
  const fullPath = [...ancestors, title].join('/');
  return patterns.some(
    (pattern) =>
      ids.some((id) => pattern === id || pattern === `id:${id}`) ||
      matchesPattern(pattern, title) ||
      ancestors.some((ancestor) => matchesPattern(pattern, ancestor)) ||
      matchesPattern(pattern, fullPath),
  );
}

/** A rule's two expressions, built once: the whole text, then anywhere in it. `null` when it is not one. */
const compiled = new Map<string, { whole: RegExp; anywhere: RegExp } | null>();

function expressionsOf(rule: string): { whole: RegExp; anywhere: RegExp } | null {
  let hit = compiled.get(rule);
  if (hit !== undefined) return hit;
  const source = rule
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\/$/, '(/.*)?');
  try {
    hit = { whole: new RegExp(`^${source}$`, 'i'), anywhere: new RegExp(source, 'i') };
  } catch {
    // A rule containing `?` can still form an invalid expression; it then matches as plain text.
    hit = null;
  }
  compiled.set(rule, hit);
  return hit;
}

/**
 * Whether one rule matches a title or path, ignoring case. `*` matches anything, and a trailing
 * `/` also matches everything below. The rule is tried against the whole text and then anywhere in
 * it, so `Restricted/` also matches `Unrestricted Access Guide`. That over-match is a known defect
 * the maintainer has deferred (ADR-013); over-excluding is the safe direction for these rules.
 */
export function matchesPattern(pattern: string, target: string): boolean {
  const rule = pattern.trim();
  if (!rule || !target) return false;
  if (rule.toLowerCase() === target.toLowerCase()) return true;
  const expressions = expressionsOf(rule);
  return expressions
    ? expressions.whole.test(target) || expressions.anywhere.test(target)
    : target.toLowerCase().includes(rule.toLowerCase());
}
