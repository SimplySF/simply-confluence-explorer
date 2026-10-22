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

// Reads the files inside a zip archive with Node's own zlib, so Office and OpenDocument attachments,
// which are zip archives of XML, can be read without a library (ADR-069). An attachment comes from
// whoever uploaded it to Confluence, so every size is bounded: a small archive that inflates to
// gigabytes (a zip bomb) is refused rather than read.

import zlib from 'node:zlib';

/** The most entries an archive may list, and the most its entries may inflate to, together. */
export const ZIP_ENTRIES = 2000;
export const ZIP_BYTES = 20 * 1024 * 1024;

export type ZipEntry = { name: string; size: number; read: () => Buffer };

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * The files in a zip archive, each read only when asked for. Throws an error that says why when the
 * archive cannot be read, or would hold more than the limits allow.
 *
 * @param data The archive.
 */
export function zipEntries(data: Buffer): ZipEntry[] {
  // The end record sits in the last 22 bytes, or up to 64 KB before them when the archive has a comment.
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 0xffff); at--)
    if (data.readUInt32LE(at) === END) {
      end = at;
      break;
    }
  if (end < 0) throw new Error('not a zip archive');
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('a zip archive too large to read (zip64)');
  if (count > ZIP_ENTRIES) throw new Error(`an archive of more than ${ZIP_ENTRIES} files`);
  let inflated = 0;
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== CENTRAL) throw new Error('a damaged zip archive');
    const method = data.readUInt16LE(at + 10);
    const packed = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const local = data.readUInt32LE(at + 42);
    const name = data.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    entries.push({
      name,
      size,
      read: (): Buffer => {
        if (local + 30 > data.length || data.readUInt32LE(local) !== LOCAL) throw new Error('a damaged zip archive');
        const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
        const body = data.subarray(start, start + packed);
        const room = ZIP_BYTES - inflated;
        if (size > room) throw new Error('an archive whose files are too large to read');
        let out: Buffer;
        if (method === 0) out = Buffer.from(body);
        else if (method === 8) out = zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, room) });
        else throw new Error(`a zip archive packed in a way the app cannot read (method ${method})`);
        inflated += out.length;
        return out;
      },
    });
  }
  return entries;
}
