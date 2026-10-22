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

// The words for an account of a chat's attachments (ADR-069): how many there are, what each was read
// as, the images, and every file not read with why, so no attachment is passed over unsaid.

import type { AttachmentsReport } from '../../../src/api/types.js';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 PDF, 2 Word": the files read, counted by what they were read as, the most first. */
export function readKinds(report: Pick<AttachmentsReport, 'read'>): string {
  const counts = new Map<string, number>();
  for (const r of report.read) {
    const kind = r.as.split(',')[0];
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ');
}

/**
 * An account in a line, and each file in its own: those read, and those not, with why.
 *
 * @param report The account.
 * @param before True before a question, when it says what will be read rather than what was.
 */
export function attachmentLines(
  report: AttachmentsReport,
  before = false,
): { line: string; read: string[]; unread: string[] } {
  const parts = [
    report.read.length ? `${report.read.length} ${before ? 'to read' : 'read'} (${readKinds(report)})` : '',
    report.images.sent ? `${plural(report.images.sent, 'image')} sent without leak-guard checks` : '',
    report.unread.length ? `${report.unread.length} not ${before ? 'to be ' : ''}read` : '',
  ].filter(Boolean);
  const imagesWaiting =
    before && report.images.found && report.choice !== 'pages' ? plural(report.images.found, 'image') : '';
  return {
    line: `${plural(report.files, 'attachment')}${parts.length || imagesWaiting ? ': ' : ''}${[...parts, imagesWaiting].filter(Boolean).join(' · ')}`,
    read: report.read.map(
      (r) =>
        `${r.page} / ${r.name}: ${r.as}${r.cut ? `, only its first ${r.cut.toLocaleString('en')} characters` : ''}`,
    ),
    unread: report.unread.map((u) => `${u.page} / ${u.name}: ${u.why}`),
  };
}
