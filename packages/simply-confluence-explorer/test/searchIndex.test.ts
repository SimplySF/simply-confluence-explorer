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

// The search over a synced space that finds pages a new page might repeat (ADR-025).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PageDetail } from '../src/api/types.js';
import { ExclusionManager } from '../src/spaces/exclusionManager.js';
import { SearchIndex, tokens } from '../src/spaces/searchIndex.js';
import { SpaceStore } from '../src/spaces/spaceStore.js';

const page = (id: string, title: string, body: string, version = 1): PageDetail => ({
  id,
  title,
  spaceKey: 'PLAT',
  version,
  author: 'admin',
  lastModified: '2026-01-01T00:00:00Z',
  storageXml: `<p>${body}</p>`,
  labels: [],
  attachments: [],
  ancestors: [],
});

function setup(): { store: SpaceStore; index: SearchIndex; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-search-'));
  const log = (): void => undefined;
  const store = new SpaceStore(dataDir, new ExclusionManager(dataDir, log), log);
  const write = (p: PageDetail): void => store.writePage('PLAT', p, p.storageXml, []);
  write(page('1', 'Database Failover', 'Promote the replica when the primary is lost.'));
  write(page('2', 'Gateway Service', 'Routes requests. During a database failover the gateway retries.'));
  write(page('3', 'Production Credentials', 'Where the database passwords are kept.'));
  return { store, index: new SearchIndex(store), dataDir };
}

const ids = (index: SearchIndex, query: string): string[] => index.search('PLAT', query).map((h) => h.pageId);

describe('the search index', () => {
  it('leaves out short and common words', () => {
    expect(tokens('How to fail over the DB, and promote it')).toEqual(['fail', 'promote']);
  });

  it('ranks a page whose title matches above one that only mentions the words', () => {
    const { index } = setup();
    expect(ids(index, 'database failover').slice(0, 2)).toEqual(['1', '2']);
  });

  it('finds nothing in a space that is not synced', () => {
    const { index } = setup();
    expect(index.search('OPS', 'database')).toEqual([]);
  });

  it('never returns a page the exclusion rules hide, and follows a change to the rules', () => {
    const { index, store } = setup();
    expect(ids(index, 'database passwords')).toContain('3');
    fs.writeFileSync(path.join(store.spaceDir('PLAT'), '.confluenceignore'), 'Production Credentials\n');
    store.invalidate('PLAT');
    expect(ids(index, 'database passwords')).not.toContain('3');
  });

  it('sees a page rewritten in place, as a push leaves it', () => {
    const { index, store } = setup();
    expect(ids(index, 'quorum')).toEqual([]);
    const file = path.join(store.spaceDir('PLAT'), 'pages_cache', '2.json');
    const before = fs.statSync(file).mtimeMs;
    store.refreshPage('PLAT', page('2', 'Gateway Service', 'Routes requests and waits for quorum.', 2));
    // The rewrite must land on a later file time than the first write for the test to mean anything.
    fs.utimesSync(file, new Date(), new Date(before + 1000));
    expect(ids(index, 'quorum')).toEqual(['2']);
  });

  it('finds the section of a page that answers, not only the page', () => {
    const { index, store } = setup();
    const runbook = page('4', 'Runbook', '');
    runbook.storageXml = '<h1>Deploy</h1><p>Ship the build.</p><h1>Rollback</h1><p>Revert the release tag.</p>';
    store.writePage('PLAT', runbook, '', []);
    const [hit] = index.searchSections('PLAT', 'revert release', 5);
    expect([hit.section.pageId, hit.section.path]).toEqual(['4', ['Rollback']]);
    // The word is only in the heading, which the section is found by.
    expect(index.searchSections('PLAT', 'rollback', 5)[0].section.path).toEqual(['Rollback']);
  });

  it('searches only the pages it is given', () => {
    const { index } = setup();
    const hits = index.searchSections('PLAT', 'database', 10, new Set(['2']));
    expect(hits.map((h) => h.section.pageId)).toEqual(['2']);
  });

  it('splits a page again only when its version changes', () => {
    const { index, store } = setup();
    const first = index.sectionsOf('PLAT', '1');
    // A new summary changes the index stamp but not the page, so the page's sections are reused.
    store.writeMetadata('PLAT', {
      pageId: '2',
      title: 'Gateway Service',
      summary: 'Routes requests.',
      tags: [],
      documentType: 'overview',
      systemsMentioned: [],
      generatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(index.sectionsOf('PLAT', '1')[0]).toBe(first[0]);
    store.refreshPage('PLAT', page('1', 'Database Failover', 'Promote the replica.', 2));
    const file = path.join(store.spaceDir('PLAT'), 'pages_cache', '1.json');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(index.sectionsOf('PLAT', '1')[0]).not.toBe(first[0]);
    expect(index.sectionsOf('PLAT', '1')[0].text).toBe('Promote the replica.');
  });

  it('finds a section by its summary and a page by the questions it answers', () => {
    const { index, store } = setup();
    store.writeMetadata('PLAT', {
      pageId: '3',
      title: 'Production Credentials',
      summary: 'Secrets storage.',
      tags: [],
      documentType: 'reference',
      systemsMentioned: [],
      generatedAt: '2026-01-01T00:00:00Z',
      version: 2,
      questions: ['Who rotates the vault keys?'],
      sections: [{ heading: 'Production Credentials', summary: 'Explains the keystore layout.' }],
    });
    expect(index.searchSections('PLAT', 'keystore', 5).map((h) => h.section.pageId)).toEqual(['3']);
    expect(ids(index, 'rotates vault')).toEqual(['3']);
  });
});

describe('reading a corpus in full', () => {
  it('retrieves instead when the pages turn out larger than estimated, rather than leaving some out', async () => {
    const { retrieveContext, corpusSize } = await import('../src/spaces/contextRetriever.js');
    const { store, index, dataDir } = setup();
    const long = page('9', 'Headings', '');
    // Long headings count for little in the estimate but take their full length when the page is read.
    long.storageXml = Array.from({ length: 8 }, (_, i) => `<h2>${'Heading words '.repeat(12)}${i}</h2><p>x</p>`).join(
      '',
    );
    store.writePage('PLAT', long, '', []);
    const pages = store.visiblePages('PLAT');
    const exclusions = new ExclusionManager(dataDir, () => undefined);
    const budget = corpusSize('PLAT', pages, index) + 50;
    const r = await retrieveContext(
      'PLAT',
      pages,
      { question: 'heading words' },
      { store, exclusions, index, dataDir },
      { budget },
    );
    expect(r.corpus.mode).toBe('retrieved');
  });
});
