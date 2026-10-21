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

// How Confluence pages become Markdown. The north star asks that the model sees what Confluence says,
// so a page's Markdown must keep its text, its structure and the meaning its macros carry.
//
// Every page in the test dataset is converted and compared with a recorded snapshot, so any change
// in simply-atlassian-core's converter shows up as a reviewed diff. The output of the turndown-based
// converter the app used before the library is kept beside it, in fixtures/turndown-baseline.json,
// for comparison (ADR-028). Five things that baseline kept and the library once lost each have a test
// of their own below (ADR-033).

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { markdownToStorage, storageToMarkdown } from '@simplysf/simply-atlassian-core';
import { spaces, type DatasetPage } from '../../../test-env/fixtures/dataset.mjs';
import type { PageDetail } from '../src/api/types.js';
import { missingParts, parsePage, RECORD_FIELDS, storageToBody, stripFrontmatter } from '../src/parser/convert.js';

const ctx = { userKey: 'admin-user-key' };

function datasetBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  const walk = (key: string, nodes: DatasetPage[] = []): void => {
    for (const node of nodes) {
      const body = typeof node.body === 'function' ? node.body(ctx) : node.body;
      if (body) bodies.set(`${key}/${node.title}`, body);
      walk(key, node.children);
    }
  };
  for (const space of spaces) {
    bodies.set(`${space.key}/${space.name} Home`, space.home);
    walk(space.key, space.pages);
  }
  return bodies;
}

const bodies = datasetBodies();
const md = (key: string): string => storageToBody(bodies.get(key)!);

describe('converting the test dataset', () => {
  it('has a turndown baseline for every page with a body, so the comparison covers the whole dataset', () => {
    const baseline = JSON.parse(
      fs.readFileSync(new URL('fixtures/turndown-baseline.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    expect(Object.keys(baseline).sort()).toEqual([...bodies.keys()].sort());
  });

  for (const key of bodies.keys()) {
    it(`converts ${key} as recorded`, () => {
      expect(md(key)).toMatchSnapshot();
    });
  }
});

describe('what the converter keeps', () => {
  it('keeps code blocks with their language', () => {
    expect(md('PLAT/Architecture Overview')).toContain("```typescript\nimport express from 'express';");
  });

  it('keeps tables as Markdown tables', () => {
    expect(md('PLAT/Architecture Overview')).toContain('| API Gateway | Platform | Go |');
  });

  it('keeps task lists with whether each task is done', () => {
    expect(md('PLAT/INC-1001: Gateway latency spike')).toContain('- [x] Add alerting\n- [ ] Write regression test');
  });

  it('keeps the spacing of preformatted text', () => {
    expect(md('PLAT/Architecture Overview')).toContain('raw   preformatted');
  });

  it('marks a macro it cannot convert instead of dropping it silently', () => {
    expect(md('PLAT/Architecture Overview')).toContain('[macro: jira]');
  });

  it('keeps the words of a page link', () => {
    expect(md('PLAT/Architecture Overview')).toContain('[Gateway Service]');
  });
});

describe('what the converter keeps from macros', () => {
  it("keeps a status lozenge's text, such as an incident's severity", () => {
    expect(md('PLAT/INC-1001: Gateway latency spike')).toContain('SEV2');
  });

  it("keeps a panel's title", () => {
    expect(md('PLAT/Gateway Runbook')).toContain('Paging policy');
  });

  it("keeps an expand section's title", () => {
    expect(md('PLAT/Architecture Overview')).toContain('Show legacy details');
  });

  it('keeps who a mention names', () => {
    expect(md('PLAT/Architecture Overview')).toContain('admin-user-key');
  });

  it("keeps a nested table's cells apart", () => {
    expect(md('OPS/Service Level Objectives')).not.toContain('ZoneUptime');
  });
});

// Markdown has no form for some parts of a page, so writing a page from its plain Markdown would turn
// each of them into placeholder text. A write builds the page from its edit form instead (ADR-058),
// and compares what it is about to send with the page, so these are what that comparison catches.
describe('what writing a page back from its plain Markdown would lose', () => {
  const plain = (storage: string): string => {
    try {
      return markdownToStorage(storageToMarkdown(storage));
    } catch {
      // A task list has no Markdown form, so the page's Markdown cannot be written back at all.
      return '';
    }
  };
  const lost = (key: string): string[] => missingParts(bodies.get(key)!, plain(bodies.get(key)!));

  it('is nothing for a page of headings, tables and code', () => {
    expect(lost('PLAT/Gateway API Reference')).toEqual([]);
  });

  it('names each image, macro, page link and mention a page holds, keeping the code blocks off the list', () => {
    expect(lost('PLAT/Architecture Overview')).toEqual(
      expect.arrayContaining(['1 image', '2 links to other pages', '1 mention of a person', '3 "status" macros']),
    );
    expect(lost('PLAT/Architecture Overview').join()).not.toContain('"code"');
  });

  it('names a task list, which cannot be written from Markdown at all', () => {
    expect(lost('PLAT/INC-1001: Gateway latency spike')).toEqual(['1 task list', '1 "toc" macro', '1 "status" macro']);
  });

  it('names the parts that were once lost without a word: emoticons, inline comments, anchors and attachments', () => {
    const page =
      '<p><ac:emoticon ac:name="smile" /> <ac:inline-comment-marker ac:ref="a1">noted</ac:inline-comment-marker> ' +
      '<ac:link ac:anchor="setup"><ac:plain-text-link-body><![CDATA[Setup]]></ac:plain-text-link-body></ac:link> ' +
      '<ac:link><ri:attachment ri:filename="notes.txt" /></ac:link></p>';
    expect(missingParts(page, plain(page))).toEqual([
      '1 link to an attachment',
      '1 link to an anchor',
      '1 emoticon',
      '1 inline comment',
    ]);
  });
});

describe('frontmatter', () => {
  const page: PageDetail = {
    id: '42',
    title: 'Database Failover',
    spaceKey: 'OPS',
    version: 3,
    author: 'Test Admin',
    lastModified: '2026-01-01T00:00:00.000Z',
    webUrl: 'https://confluence.example.com/pages/viewpage.action?pageId=42',
    storageXml: '<h2>Steps</h2><p>Promote the replica.</p>',
    labels: ['runbook'],
    attachments: [],
    ancestors: [{ id: '1', title: 'Runbooks' }],
  };

  it("records the page's source, so a saved copy can be traced back to it", () => {
    const parsed = parsePage(page);
    expect(parsed.markdown).toMatch(/^---\nid: "42"\ntitle: Database Failover\nspace: OPS\nversion: 3\n/);
    expect(parsed.markdown).toContain('breadcrumbs:\n  - Runbooks');
    expect(parsed.markdown).toContain('## Steps\n\nPromote the replica.');
  });

  it('is stripped before a body is pushed, and a body without one is left alone', () => {
    expect(stripFrontmatter(parsePage(page).markdown)).toBe('## Steps\n\nPromote the replica.\n');
    expect(stripFrontmatter('# No frontmatter\n---\nnot yaml')).toBe('# No frontmatter\n---\nnot yaml');
  });

  it("is stripped when a model echoes it after the page's title line, in a yaml fence, or twice", () => {
    const record = parsePage(page).markdown.split('\n## Steps')[0];
    const body = '## Steps\n\nPromote the replica.';
    expect(stripFrontmatter(`# Document Title: Database Failover\n\n${record}\n${body}`)).toBe(body);
    expect(stripFrontmatter(`\`\`\`yaml\n${record.trim()}\n\`\`\`\n\n${body}`)).toBe(body);
    expect(stripFrontmatter(`${record}${record}\n${body}`)).toBe(body);
  });

  it('names every field it writes, so a check for the record cannot miss one', () => {
    expect(Object.keys(parsePage(page).frontmatter)).toEqual([...RECORD_FIELDS]);
  });
});
