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

// A space's page catalog (ADR-064): tags and the tree come from it without reading every page's
// file, it changes as pages and metadata are written, it survives a restart, and it is built again
// whenever it cannot be trusted.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PageDetail, PageMetadata } from '../src/api/types.js';
import { ExclusionManager } from '../src/spaces/exclusionManager.js';
import { SpaceStore } from '../src/spaces/spaceStore.js';
import { tagIndex } from '../src/spaces/tags.js';

const page = (id: string, title: string, extra: Partial<PageDetail> = {}): PageDetail => ({
  id,
  title,
  spaceKey: 'PLAT',
  version: 1,
  author: 'admin',
  lastModified: '2026-01-01T00:00:00Z',
  storageXml: '<p>Text.</p>',
  labels: [],
  attachments: [],
  ancestors: [],
  ...extra,
});
const meta = (pageId: string, tags: string[]): PageMetadata => ({
  pageId,
  title: pageId,
  summary: `About ${pageId}.`,
  tags,
  documentType: 'guide',
  systemsMentioned: [],
  generatedAt: '2026-01-01T00:00:00Z',
  version: 2,
});

function open(dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-cat-'))): {
  store: SpaceStore;
  exclusions: ExclusionManager;
  dataDir: string;
} {
  const exclusions = new ExclusionManager(dataDir, () => undefined);
  return { store: new SpaceStore(dataDir, exclusions, () => undefined), exclusions, dataDir };
}

/** A space of three pages: a runbook with a label, a page under it with AI tags, and another. */
function seeded(): ReturnType<typeof open> {
  const opened = open();
  const { store } = opened;
  store.writePage('PLAT', page('1', 'Runbooks', { labels: ['runbook'] }), '', []);
  store.writePage(
    'PLAT',
    page('2', 'Failover', { parentId: '1', ancestors: [{ id: '1', title: 'Runbooks' }] }),
    '',
    [],
  );
  store.writePage('PLAT', page('3', 'Onboarding'), '', []);
  store.writeMetadata('PLAT', meta('2', ['database']));
  return opened;
}
const tagsIn = async (store: SpaceStore): Promise<Record<string, string[]>> =>
  Object.fromEntries((await tagIndex(store, 'PLAT')).map((t) => [t.tag, t.pages.map((p) => p.title)]));

describe('saving the page catalog later', () => {
  it('a catalog save after its space folder was deleted does not throw, where it stopped the test run and would stop the app', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-cat-'));
    const logged: string[] = [];
    const store = new SpaceStore(dataDir, new ExclusionManager(dataDir, () => undefined), (m) => logged.push(m));
    store.writePage('PLAT', page('1', 'Runbooks'), '', []);
    await store.catalog.ready('PLAT');
    vi.useFakeTimers();
    try {
      store.writePage('PLAT', page('2', 'Failover'), '', []);
      fs.rmSync(path.join(dataDir, 'spaces', 'PLAT'), { recursive: true });
      expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
    expect(logged).toEqual([expect.stringMatching(/^could not save the page catalog of PLAT: /)]);
    expect(fs.existsSync(path.join(dataDir, 'spaces', 'PLAT'))).toBe(false);
  });
});
describe("a space's tags", () => {
  it('come from its catalog, so a second look reads no page file, which took minutes on a large space', async () => {
    const { store } = seeded();
    expect(await tagsIn(store)).toEqual({ runbook: ['Runbooks'], database: ['Failover'] });
    const reads = vi.spyOn(store, 'readPage');
    expect(await tagsIn(store)).toEqual({ runbook: ['Runbooks'], database: ['Failover'] });
    await store.treeReady('PLAT');
    expect(reads).not.toHaveBeenCalled();
  });

  it('are built once however many ask while it is built', async () => {
    const { store } = seeded();
    const reads = vi.spyOn(store, 'readPage');
    await Promise.all([tagIndex(store, 'PLAT'), tagIndex(store, 'PLAT'), store.treeReady('PLAT')]);
    expect(reads).toHaveBeenCalledTimes(3);
  });
});

describe("a space's catalog", () => {
  it('changes at once as a page is synced, indexed, changed and removed', async () => {
    const { store } = seeded();
    await tagsIn(store);
    store.writePage('PLAT', page('4', 'Backups', { labels: ['runbook'] }), '', []);
    store.writeMetadata('PLAT', meta('3', ['people']));
    expect(await tagsIn(store)).toEqual({
      runbook: ['Backups', 'Runbooks'],
      database: ['Failover'],
      people: ['Onboarding'],
    });
    // A newer version of a page has no AI tags until it is indexed again.
    store.writePage(
      'PLAT',
      page('2', 'Failover', { version: 2, parentId: '1', ancestors: [{ id: '1', title: 'Runbooks' }] }),
      '',
      [],
    );
    await store.purgePage('PLAT', '4', { includeSubPages: false, addToIgnore: false });
    expect(await tagsIn(store)).toEqual({ runbook: ['Runbooks'], people: ['Onboarding'] });
  });

  it('applies an exclusion rule added after it was built, to the tags and the tree at once', async () => {
    const { store, exclusions } = seeded();
    await tagsIn(store);
    exclusions.savePatterns('PLAT', ['Runbooks/']);
    store.invalidate('PLAT');
    expect(await tagsIn(store)).toEqual({});
    expect(store.tree('PLAT').map((n) => n.title)).toEqual(['Onboarding']);
  });

  it('is kept across a restart, so the first look after one reads no page file either', async () => {
    const { store, dataDir } = seeded();
    await tagsIn(store);
    store.catalog.save('PLAT');
    const restarted = open(dataDir).store;
    const reads = vi.spyOn(restarted, 'readPage');
    expect(await tagsIn(restarted)).toEqual({ runbook: ['Runbooks'], database: ['Failover'] });
    expect(reads).not.toHaveBeenCalled();
  });

  it('is not trusted by an app restarted before a change was saved, which would show old tags', async () => {
    const { store, dataDir } = seeded();
    await tagsIn(store);
    store.catalog.save('PLAT');
    store.writeMetadata('PLAT', meta('3', ['people']));
    // As if the app stopped now, before the catalog's save a moment after the change.
    expect(await tagsIn(open(dataDir).store)).toEqual({
      runbook: ['Runbooks'],
      database: ['Failover'],
      people: ['Onboarding'],
    });
  });

  it('is built again when its file is missing, damaged, of an older kind, or out of step with the pages', async () => {
    const { store, dataDir } = seeded();
    await tagsIn(store);
    store.catalog.save('PLAT');
    const file = path.join(store.spaceDir('PLAT'), 'catalog.json');
    const saved = fs.readFileSync(file, 'utf8');
    const rebuilt = async (change: () => void): Promise<boolean> => {
      fs.writeFileSync(file, saved);
      change();
      const restarted = open(dataDir).store;
      const reads = vi.spyOn(restarted, 'readPage');
      await tagsIn(restarted);
      return reads.mock.calls.length > 0;
    };
    expect(await rebuilt(() => undefined)).toBe(false);
    expect(await rebuilt(() => fs.rmSync(file))).toBe(true);
    expect(await rebuilt(() => fs.writeFileSync(file, '{ not json'))).toBe(true);
    expect(await rebuilt(() => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), format: 0 })))).toBe(true);
    const cache = path.join(store.spaceDir('PLAT'), 'pages_cache');
    expect(await rebuilt(() => fs.copyFileSync(path.join(cache, '3.json'), path.join(cache, '5.json')))).toBe(true);
  });

  it('says how far a first build has got, and nothing once it can be read at once', async () => {
    const { store } = seeded();
    expect(store.catalog.progress('PLAT')).toEqual({ done: expect.any(Number), total: 3 });
    await store.catalog.ready('PLAT');
    expect(store.catalog.progress('PLAT')).toBeUndefined();
  });
});

describe("a synced page's attachment files", () => {
  const files = (store: SpaceStore, p: PageDetail): string[] =>
    store.attachmentFiles('PLAT', p).map((f) => path.basename(f.file));
  const withAttachments = (titles: string[]): PageDetail =>
    page('9', 'Shots', {
      attachments: titles.map((title, i) => ({
        id: `a${i}`,
        title,
        mediaType: 'image/png',
        fileSize: 1,
        downloadUrl: '',
      })),
    });

  it('keep two whose names become the same on disk apart, where one overwrote the other', () => {
    const { store } = open();
    const p = withAttachments(['a/b.png', 'a:b.png']);
    store.writePage('PLAT', p, '', [
      { name: 'a/b.png', data: Buffer.from('one') },
      { name: 'a:b.png', data: Buffer.from('two') },
    ]);
    const kept = store.attachmentFiles('PLAT', p).map((f) => fs.readFileSync(f.file, 'utf8'));
    expect(kept).toEqual(['one', 'two']);
    expect(new Set(files(store, p)).size).toBe(2);
  });

  it('lose a file deleted in Confluence at the next sync, which stayed on disk for good', () => {
    const { store } = open();
    store.writePage('PLAT', withAttachments(['one.png', 'two.png']), '', [
      { name: 'one.png', data: Buffer.from('1') },
      { name: 'two.png', data: Buffer.from('2') },
    ]);
    const after = withAttachments(['one.png']);
    store.writePage('PLAT', after, '', [{ name: 'one.png', data: Buffer.from('1') }]);
    const dir = path.dirname(store.attachmentFiles('PLAT', after)[0].file);
    expect(fs.readdirSync(dir)).toEqual(['one.png']);
    // A page read again after a push keeps its files: nothing was downloaded to replace them.
    store.refreshPage('PLAT', after);
    expect(fs.readdirSync(dir)).toEqual(['one.png']);
  });
});
