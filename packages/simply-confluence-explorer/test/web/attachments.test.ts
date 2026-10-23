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

import { describe, expect, it } from 'vitest';
import type { AttachmentsReport } from '../../src/api/types.js';
import { attachmentLines, everyKey, filesByPage, readKinds } from '../../web/src/support/attachments.js';

const report: AttachmentsReport = {
  files: 6,
  read: [
    { page: 'Runbook', name: 'a.pdf', as: 'PDF' },
    { page: 'Runbook', name: 'b.pdf', as: 'PDF, searched for the parts that match' },
    { page: 'Runbook', name: 'limits.xlsx', as: 'Excel', cut: 50000 },
  ],
  unread: [
    { pageId: '7', page: 'Runbook', name: 'old.doc', why: 'an older binary format' },
    { pageId: '7', page: 'Runbook', name: 'notes.docx', why: 'left out by you', left: true },
    {
      pageId: '7',
      page: 'Runbook',
      name: 'shot.png',
      why: 'an image: sent only once you choose',
      image: true,
      new: true,
    },
  ],
  images: { found: 1, sent: 0, choice: 'ask' },
};

describe("the account of a chat's attachments", () => {
  it('counts what was read by kind, the most first', () => {
    expect(readKinds(report)).toBe('2 PDF, 1 Excel');
  });

  it('says in a line what was read and what was not, and names each file with why', () => {
    const lines = attachmentLines(report);
    expect(lines.line).toBe(
      '6 attachments: 3 read (2 PDF, 1 Excel) · 1 left out by you · 1 not read · 1 image not sent',
    );
    expect(lines.unread[0]).toBe('Runbook / old.doc: an older binary format');
    expect(lines.read).toContain('Runbook / limits.xlsx: Excel, only its first 50,000 characters');
  });

  it('says before a question what will be read, and the images waiting on a choice', () => {
    expect(attachmentLines(report, true).line).toBe(
      '6 attachments: 3 to read (2 PDF, 1 Excel) · 1 left out by you · 1 not to be read · 1 image not sent',
    );
  });

  it('lists each file under its page, ticked when it goes, unticked when left out, and fixed when unreadable', () => {
    const [runbook] = filesByPage(report);
    expect(runbook.page).toBe('Runbook');
    expect(runbook.files.map((f) => [f.name, f.state, f.new ?? false])).toEqual([
      ['a.pdf', 'on', false],
      ['b.pdf', 'on', false],
      ['limits.xlsx', 'on', false],
      ['old.doc', 'fixed', false],
      ['notes.docx', 'off', false],
      ['shot.png', 'on', true],
    ]);
    expect(everyKey(report)).toContain('7/notes.docx');
  });
});
