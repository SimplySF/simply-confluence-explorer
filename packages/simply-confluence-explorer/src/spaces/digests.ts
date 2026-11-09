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

// Directory digests (ADR-079, design doc 0017): what the pages below a directory are about, written
// by the AI from its children's titles, summaries and tags and the digests of the directories below,
// never from page text. Each digest carries a stamp of the allowed pages it was made from, worked out
// again from the tree and the exclusion rules whenever a digest is read, so a digest made before a
// rule was added is never used, and is dropped from digests.json at the next write.

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { DirectoryDigest, DirectoryKind, PageTreeNode } from '../api/types.js';
import type { AiEngine } from '../ai/engine.js';
import { askStructured, type StructuredPrompt } from '../ai/structured.js';
import type { Tracer } from '../telemetry/tracer.js';
import { within } from '../util/paths.js';
import type { CatalogEntry } from './catalog.js';
import type { ExclusionManager } from './exclusionManager.js';
import { seriesKey, seriesOf } from './spaceMap.js';
import type { SpaceStore } from './spaceStore.js';

const KINDS: DirectoryKind[] = ['living', 'archive-series', 'templates', 'mixed'];
/** The most lines one directory's input lists; the rest are counted. */
const MAX_LINES = 60;
/** Leaf children with one title apart from numbers and dates collapse to one line from this many. */
const SERIES_MIN = 3;
/** The most directories one request describes, so one reply stays short enough to follow. */
export const DIRECTORIES_PER_REQUEST = 12;

/** A directory as the current tree has it, with its stamp. Every field holds allowed pages only. */
type Directory = {
  node: PageTreeNode;
  entry?: CatalogEntry;
  path: string[];
  /** Pages below it at any depth. */
  pages: number;
  /** 1 for a directory with no directories below it, one more than its deepest child directory otherwise. */
  height: number;
  parent?: string;
  stamp: string;
};

type View = { signature: string; directories: Map<string, Directory> };

/** A directory to digest: its input as the request carries it, and the stamp the digest is given. */
export type DigestTask = { id: string; title: string; stamp: string; input: string };

/**
 * The directory digests of every synced space: kept in `spaces/<KEY>/digests.json`, read only when
 * current. `currentDigest` is what retrieval reads.
 */
export class DigestStore {
  private readonly views = new Map<string, View>();
  private readonly files = new Map<string, { mtimeMs: number; digests: Record<string, DirectoryDigest> }>();
  /** Grows with every write, so a view that counted a child's digest as missing is worked out again. */
  private writes = 0;

  public constructor(
    private readonly store: SpaceStore,
    private readonly exclusions: ExclusionManager,
  ) {}

  /** A directory's digest when its stamp matches the allowed pages below it now, else `undefined`. */
  public currentDigest(spaceKey: string, dirId: string): DirectoryDigest | undefined {
    const key = spaceKey.toUpperCase();
    const dir = this.view(key).get(dirId);
    const digest = this.read(key)[dirId];
    if (!dir) return undefined;
    return digest?.stamp === dir.stamp ? digest : undefined;
  }

  /** Every current digest of a space, by directory id. */
  public currentDigests(spaceKey: string): Map<string, DirectoryDigest> {
    const key = spaceKey.toUpperCase();
    const stored = this.read(key);
    const out = new Map<string, DirectoryDigest>();
    for (const [id, dir] of this.view(key)) if (stored[id]?.stamp === dir.stamp) out.set(id, stored[id]);
    return out;
  }

  /** The stamp a directory's digest must carry now, or `undefined` when it is not a visible directory. */
  public stampOf(spaceKey: string, dirId: string): string | undefined {
    return this.view(spaceKey.toUpperCase()).get(dirId)?.stamp;
  }

  /**
   * The directories of a space, or of the subtree at `rootPageId`, that lack a current digest, with
   * every directory above them in scope, whose digest goes stale once theirs is written. Grouped by
   * height, lowest first, so a directory comes after every directory below it.
   */
  public pending(spaceKey: string, rootPageId?: string): string[][] {
    const key = spaceKey.toUpperCase();
    const dirs = this.view(key);
    const current = this.currentDigests(key);
    const inScope = (id: string): boolean => {
      if (!rootPageId) return true;
      for (let at: string | undefined = id; at; at = dirs.get(at)?.parent) if (at === rootPageId) return true;
      return false;
    };
    const wanted = new Set<string>();
    for (const id of dirs.keys()) {
      if (current.has(id) || !inScope(id)) continue;
      for (let at: string | undefined = id; at && inScope(at); at = dirs.get(at)?.parent) wanted.add(at);
    }
    const levels: string[][] = [];
    for (const id of wanted) (levels[dirs.get(id)!.height - 1] ??= []).push(id);
    return levels.filter(Boolean);
  }

  /** What a request sends about a directory, worked out from the tree as it is now; `undefined` once it is gone. */
  public task(spaceKey: string, dirId: string): DigestTask | undefined {
    const key = spaceKey.toUpperCase();
    const dir = this.view(key).get(dirId);
    if (!dir) return undefined;
    return { id: dirId, title: dir.node.title, stamp: dir.stamp, input: this.inputOf(key, dir) };
  }

  /**
   * Saves digests, then drops every stored digest whose stamp no longer matches, so a directory that
   * an exclusion rule hid, and the titles in its digest, leave the file.
   */
  public write(spaceKey: string, digests: DirectoryDigest[]): void {
    const key = spaceKey.toUpperCase();
    const all = { ...this.read(key) };
    for (const d of digests) all[d.id] = d;
    const dirs = this.directoriesOf(key, all);
    const kept = Object.fromEntries(Object.entries(all).filter(([id, d]) => dirs.get(id)?.stamp === d.stamp));
    const file = this.file(key);
    // Written beside it and moved into place, so a reader never finds half a file.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(kept), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
    this.files.set(key, { mtimeMs: fs.statSync(file).mtimeMs, digests: kept });
    this.writes++;
  }

  private file(key: string): string {
    return within(this.store.spaceDir(key), 'digests.json');
  }

  /** The stored digests, read again only when the file changes. A damaged file counts as none. */
  private read(key: string): Record<string, DirectoryDigest> {
    const file = this.file(key);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) return {};
    const kept = this.files.get(key);
    if (kept?.mtimeMs === stat.mtimeMs) return kept.digests;
    let digests: Record<string, DirectoryDigest> = {};
    try {
      digests = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, DirectoryDigest>;
    } catch {
      // A damaged file is the same as no digests: every directory is digested again on the next run.
    }
    this.files.set(key, { mtimeMs: stat.mtimeMs, digests });
    this.writes++;
    return digests;
  }

  /**
   * Every visible directory with its stamp, worked out once for each state of the store, the rules
   * and the stored digests. Pages are checked against the rules here as well as in the tree, so a
   * rule takes effect even before the tree is built again.
   */
  private view(key: string): Map<string, Directory> {
    const stored = this.read(key);
    const signature = `${this.store.revision(key)}|${this.writes}|${JSON.stringify(this.exclusions.patterns(key))}`;
    const kept = this.views.get(key);
    if (kept?.signature === signature) return kept.directories;
    const directories = this.directoriesOf(key, stored);
    this.views.set(key, { signature, directories });
    return directories;
  }

  /** The visible directories with their stamps, given the digests stored. */
  private directoriesOf(key: string, stored: Record<string, DirectoryDigest>): Map<string, Directory> {
    const entries = this.store.catalog.now(key);
    const excluded = this.exclusions.checker(key);
    const allowed = (n: PageTreeNode): boolean => {
      const entry = entries.get(n.id);
      return !!entry && !excluded(entry);
    };
    const tokenOf = (entry: CatalogEntry): string =>
      `${entry.id}:${(entry.indexed ? this.store.readMetadata(key, entry.id)?.generatedAt : undefined) ?? `v${entry.version}`}`;
    const directories = new Map<string, Directory>();
    const walk = (node: PageTreeNode, path: string[], parent?: string): { pages: number; height: number } => {
      const children = node.children.filter(allowed);
      let pages = 0;
      let height = 0;
      const parts: string[] = [];
      for (const child of children) {
        const below = walk(child, [...path, node.title], node.id);
        pages += 1 + below.pages;
        height = Math.max(height, below.height);
        const childDir = directories.get(child.id);
        const own = tokenOf(entries.get(child.id)!);
        parts.push(childDir ? `${own}|${childDir.stamp}|${stored[child.id]?.stamp === childDir.stamp}` : own);
      }
      if (children.length === 0) return { pages: 0, height: 0 };
      const entry = entries.get(node.id);
      const stamp = crypto
        .createHash('sha256')
        .update([entry ? tokenOf(entry) : node.id, ...parts.sort()].join('\n'))
        .digest('hex')
        .slice(0, 32);
      directories.set(node.id, { node, entry, path, pages, height: height + 1, parent, stamp });
      return { pages, height: height + 1 };
    };
    for (const root of this.store.tree(key)) if (allowed(root)) walk(root, []);
    return directories;
  }

  /** A directory as the request describes it: lines from the catalog and the digests below, never page text. */
  private inputOf(key: string, dir: Directory): string {
    const entries = this.store.catalog.now(key);
    const dirs = this.view(key);
    const excluded = this.exclusions.checker(key);
    const children = dir.node.children.filter((c) => {
      const e = entries.get(c.id);
      return !!e && !excluded(e);
    });
    const brief = (text?: string): string => (text ? text.replace(/\s+/g, ' ').slice(0, 300) : 'not indexed yet');
    const lines: string[] = [];
    const leaves: CatalogEntry[] = [];
    for (const child of children) {
      const e = entries.get(child.id)!;
      const below = dirs.get(child.id);
      if (!below) {
        leaves.push(e);
        continue;
      }
      const digest = this.read(key)[child.id];
      lines.push(
        digest?.stamp === below.stamp
          ? `- Directory "${e.title}" (${below.pages} pages below, ${digest.kind}): ${digest.summary} Topics: ${digest.topics.join(', ')}.`
          : `- Directory "${e.title}" (${below.pages} pages below): ${brief(e.summary)}`,
      );
    }
    const series = new Map<string, CatalogEntry[]>();
    for (const e of leaves) {
      const k = seriesKey(e.title);
      if (k.includes('#')) series.set(k, [...(series.get(k) ?? []), e]);
    }
    for (const [pattern, members] of series) {
      if (members.length < SERIES_MIN) continue;
      lines.push(
        `- A series of ${members.length} pages titled like "${pattern}", from "${members[0].title}" to "${members.at(-1)!.title}"`,
      );
    }
    for (const e of leaves) {
      if ((series.get(seriesKey(e.title))?.length ?? 0) >= SERIES_MIN) continue;
      const tags = [...new Set([...(e.labels ?? []), ...(e.tags ?? [])])];
      lines.push(`- "${e.title}": ${brief(e.summary)}${tags.length ? ` Tags: ${tags.join(', ')}.` : ''}`);
    }
    const most = seriesOf(children.map((c) => c.title));
    const shown =
      lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `- and ${lines.length - MAX_LINES} more`] : lines;
    return [
      `Path: ${[...dir.path, dir.node.title].join(' › ')}`,
      `The directory's own page: ${brief(dir.entry?.summary)}`,
      `Pages below it: ${dir.pages}${most ? `, most of its children titled like "${most.pattern}"` : ''}.`,
      'Its children:',
      ...shown,
    ].join('\n');
  }
}

const DIGEST_EXAMPLE = {
  directories: [
    {
      number: 1,
      summary: 'Runbooks for the billing service: deploys, rollbacks and on-call steps.',
      kind: 'living',
      topics: ['billing', 'deploy', 'on-call'],
      questions: ['How do I roll back a billing deploy?'],
    },
  ],
};

function digestPrompt(count: number): StructuredPrompt {
  return {
    task: `Describe each of the ${count} directories of a Confluence space below from what is listed under it, and return a JSON object with one entry for every directory.`,
    rules: [
      `"directories" holds ${count} entries. Copy each entry's "number" from its directory's "=== DIRECTORY <number>: <title> ===" line.`,
      '"summary": two or three sentences on what the pages below the directory are for. Never leave it empty.',
      '"kind": "living" for pages kept up to date, "archive-series" for old or repeated pages such as release notes, "templates" for pages to copy, or "mixed".',
      '"topics": 3 to 8 topics, lower case. "questions": up to 6 questions a reader could answer from the pages below it.',
    ],
    example: JSON.stringify(DIGEST_EXAMPLE),
  };
}

const list = { type: 'array', items: { type: 'string' } };
const DIGEST_SCHEMA = {
  type: 'object',
  properties: {
    directories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          summary: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          topics: list,
          questions: list,
        },
        required: ['number', 'summary', 'kind', 'topics', 'questions'],
      },
    },
  },
  required: ['directories'],
};

type Described = Pick<DirectoryDigest, 'summary' | 'kind' | 'topics' | 'questions'>;

/** Every numbered entry of a reply, held to its bounds, or why the reply is not usable. */
export function digestEntries(json: unknown, count: number): Described[] | string {
  const raw = (json as { directories?: unknown } | null)?.directories;
  if (!Array.isArray(raw)) return 'it held no list of directories';
  const out: Described[] = [];
  for (let n = 1; n <= count; n++) {
    const e = raw.find((x: unknown) => Number((x as { number?: unknown } | null)?.number) === n) as
      Record<string, unknown> | undefined;
    if (!e) return `it left out directory ${n}`;
    if (typeof e.summary !== 'string' || !e.summary.trim()) return `it gave directory ${n} no summary`;
    if (!KINDS.includes(e.kind as DirectoryKind)) return `directory ${n}'s kind was not one of ${KINDS.join(', ')}`;
    if (!Array.isArray(e.topics) || !Array.isArray(e.questions))
      return `directory ${n} had no list of topics or of questions`;
    const strings = (v: unknown[], most: number, chars: number): string[] =>
      v
        .filter((s): s is string => typeof s === 'string' && !!s.trim())
        .slice(0, most)
        .map((s) => s.trim().slice(0, chars));
    out.push({
      summary: e.summary.trim().slice(0, 600),
      kind: e.kind as DirectoryKind,
      topics: strings(e.topics, 8, 60).map((t) => t.toLowerCase()),
      questions: strings(e.questions, 6, 300),
    });
  }
  return out;
}

/** Groups tasks into requests by size and count, in the order given. */
export function packDigests(tasks: DigestTask[], limit: number): DigestTask[][] {
  const packs: DigestTask[][] = [];
  let used = 0;
  for (const task of tasks) {
    const last = packs.at(-1);
    if (!last || last.length >= DIRECTORIES_PER_REQUEST || used + task.input.length > limit) {
      packs.push([task]);
      used = task.input.length;
    } else {
      last.push(task);
      used += task.input.length;
    }
  }
  return packs;
}

/**
 * Asks for the digests of several directories in one request, through the engine so the outbound
 * guard applies. Returns each directory's digest, or the reason none came back.
 */
export async function generateDigestPack(
  pack: DigestTask[],
  ai: AiEngine,
  spaceKey: string,
  tracer?: Tracer,
): Promise<Map<string, DirectoryDigest | Error>> {
  const reply = await askStructured({
    ai,
    input: pack.map((t, i) => `=== DIRECTORY ${i + 1}: ${t.title} ===\n${t.input}`).join('\n\n'),
    prompt: digestPrompt(pack.length),
    schema: DIGEST_SCHEMA,
    validate: (json) => digestEntries(json, pack.length),
    label: `${pack.length} directory digests`,
    spaceKey,
    tracer,
  });
  const generatedAt = new Date().toISOString();
  return new Map(
    pack.map((t, i) => [
      t.id,
      reply.ok ? { id: t.id, title: t.title, stamp: t.stamp, generatedAt, ...reply.value[i] } : new Error(reply.reason),
    ]),
  );
}
