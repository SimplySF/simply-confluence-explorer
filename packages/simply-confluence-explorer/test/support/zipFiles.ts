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

import { PassThrough } from 'node:stream';
import archiver from 'archiver';

/** A zip archive of these files, deflated as Office writes them, or stored when `store` is set. */
export async function zipFiles(files: Record<string, string | Buffer>, store = false): Promise<Buffer> {
  const archive = archiver('zip', { store, zlib: { level: 6 } });
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => out.on('end', resolve));
  archive.pipe(out);
  for (const [name, content] of Object.entries(files)) archive.append(content, { name });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** A one-sheet Excel workbook whose rows are these values. */
export const workbook = (rows: string[][]): Promise<Buffer> =>
  zipFiles({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst></sst>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows
      .map((r, i) => `<row r="${i + 1}">${r.map((v) => `<c t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`)
      .join('')}</sheetData></worksheet>`,
  });
