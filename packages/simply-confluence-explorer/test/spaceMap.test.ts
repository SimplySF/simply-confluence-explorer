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

// The Space map (design doc 0017): what sits below each directory, how old it is, and whether it is a
// series of near-identical pages, with nothing an exclusion rule hides counted or named.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PageDetail } from '../src/api/types.js';
import { ExclusionManager } from '../src/spaces/exclusionManager.js';
import { directoryStats, seriesKey, seriesOf } from '../src/spaces/spaceMap.js';
import { SpaceStore } from '../src/spaces/spaceStore.js';

const page = (id: string, title: string, parent?: PageDetail, extra: Partial<PageDetail> = {}): PageDetail => ({
  id,
  title,
  spaceKey: 'PLAT',
  version: 1,
  author: 'admin',
  lastModified: '2026-06-01T00:00:00Z',
  storageXml: '<p>Text.</p>',
  labels: [],
  attachments: [],
  ...(parent ? { parentId: parent.id } : {}),
  ancestors: parent ? [...parent.ancestors, { id: parent.id, title: parent.title }] : [],
  ...extra,
});

/** A space with a guide area and a release-notes area of eight builds from 2023, one under a year folder. */
function space(): { store: SpaceStore; exclusions: ExclusionManager } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-map-'));
  const exclusions = new ExclusionManager(dataDir, () => undefined);
  const store = new SpaceStore(dataDir, exclusions, () => undefined);
  const guides = page('1', 'Guides');
  const releases = page('2', 'Release notes');
  const year = page('3', '2023', releases, { lastModified: '2023-01-01T00:00:00Z' });
  const pages = [
    guides,
    page('10', 'Onboarding', guides, { author: 'ana', storageXml: '<p>A longer page of text.</p>' }),
    page('11', 'Failover', guides, { author: 'ben' }),
    releases,
    year,
    ...Array.from({ length: 8 }, (_, i) =>
      page(`2${i}`, `Release 4.${i}.1 notes`, i < 4 ? year : releases, {
        lastModified: `2023-0${i + 1}-15T00:00:00Z`,
      }),
    ),
  ];
  for (const p of pages) store.writePage('PLAT', p, '', []);
  return { store, exclusions };
}

async function mapOf(store: SpaceStore): Promise<ReturnType<typeof directoryStats>> {
  await store.treeReady('PLAT');
  return directoryStats(store.tree('PLAT'), await store.catalog.ready('PLAT'), new Date('2026-11-09T00:00:00Z'));
}

describe('seriesKey', () => {
  it.each([
    ['Release 4.2.1 notes', 'release # notes'],
    ['Release v5.0 notes', 'release # notes'],
    ['Standup 2024-03-05', 'standup #'],
    ['Retro March 2024', 'retro #'],
    ['Runbook', 'runbook'],
  ])('%s → %s', (title, key) => expect(seriesKey(title)).toBe(key));
});

describe('seriesOf', () => {
  it('finds a series only when it holds most of the titles and at least five of them', () => {
    const notes = ['Release 1.0 notes', 'Release 1.1 notes', 'Release 2.0 notes', 'Release 2.1 notes'];
    expect(seriesOf(notes)).toBeUndefined();
    expect(seriesOf([...notes, 'Release 3.0 notes', 'Overview'])).toEqual({ pattern: 'release # notes', pages: 5 });
    expect(seriesOf([...notes, 'Release 3.0 notes', ...'abcdef'.split('')])).toBeUndefined();
  });
});

describe('the Space map', () => {
  it('counts every page below a directory at any depth, with its size, its dates and its series, largest first', async () => {
    const { store } = space();
    const [releases, year, guides] = await mapOf(store);
    expect(releases).toMatchObject({ title: 'Release notes', pages: 9, path: [], stale: true });
    expect(releases.series).toEqual({ pattern: 'release # notes', pages: 8 });
    expect(releases.newest).toBe('2023-08-15T00:00:00Z');
    expect(releases.oldest).toBe('2023-01-01T00:00:00Z');
    expect(year).toMatchObject({ title: '2023', pages: 4, path: ['Release notes'] });
    expect(guides).toMatchObject({ title: 'Guides', pages: 2, authors: 2, stale: false, indexed: 0 });
    expect(guides.series).toBeUndefined();
    expect(guides.size).toBe('<p>A longer page of text.</p>'.length + '<p>Text.</p>'.length);
  });

  it('neither counts nor names a page an exclusion rule hides, as soon as the rule is saved', async () => {
    const { store, exclusions } = space();
    exclusions.savePatterns('PLAT', ['id:3']);
    store.invalidate('PLAT');
    const map = await mapOf(store);
    expect(map.map((d) => d.title)).toEqual(['Release notes', 'Guides']);
    expect(map[0].pages).toBe(4);
    expect(JSON.stringify(map)).not.toContain('"2023"');
  });
});
