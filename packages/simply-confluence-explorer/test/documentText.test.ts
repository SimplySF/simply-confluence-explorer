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

// Every attachment format the app reads gives the AI its text, and every other one is named with why
// (ADR-069). Each file is built here, so the tests read what Office and the diagram tools write.

import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { documentText, formatOf, gliffyLabels } from '../src/spaces/documentText.js';
import { ZIP_BYTES, ZIP_ENTRIES, zipEntries } from '../src/util/zip.js';
import { zipFiles } from './support/zipFiles.js';

const zip = zipFiles;
const text = (name: string, bytes: Buffer | string, mediaType = ''): string => {
  const read = documentText(name, mediaType, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  if ('why' in read) throw new Error(read.why);
  return read.text;
};
const why = (name: string, bytes: Buffer | string = 'x', mediaType = ''): string => {
  const read = documentText(name, mediaType, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return 'why' in read ? read.why : `read as ${read.as}`;
};

describe('Office attachments, which were never read', () => {
  it('give a Word document its paragraphs and tables, without field codes or deleted text', async () => {
    const docx = await zip({
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Rollback takes </w:t></w:r><w:r><w:t>ten minutes.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:instrText>PAGE \\* MERGEFORMAT</w:instrText><w:delText>old words</w:delText></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Service</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:p><w:r><w:t>Gateway &amp; edge</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Platform</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>',
    });
    const read = text('runbook.docx', docx);
    expect(read).toContain('Rollback takes ten minutes.');
    expect(read).toContain('Service | Owner');
    expect(read).toContain('Gateway & edge');
    expect(read).not.toContain('MERGEFORMAT');
    expect(read).not.toContain('old words');
  });

  it('give an Excel workbook each sheet by name, its rows as values, shared strings and numbers alike', async () => {
    const xlsx = await zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Q3 &amp; Q4" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml':
        '<sst><si><t>Service</t></si><si><t>Limit</t></si><si><r><t>Gate</t></r><r><t>way</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>4200</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>a, b</t></is></c><c r="B3" t="b"><v>1</v></c></row></sheetData></worksheet>',
    });
    expect(text('limits.xlsx', xlsx)).toBe('### Sheet: Q3 & Q4\nService,Limit\nGateway,,4200\n"a, b",TRUE');
  });

  it('give a PowerPoint deck each slide in order, with its speaker notes', async () => {
    const slide = (t: string): string => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
    const pptx = await zip({
      'ppt/slides/slide10.xml': slide('Last'),
      'ppt/slides/slide2.xml': slide('Second'),
      'ppt/slides/slide1.xml': slide('First'),
      'ppt/slides/_rels/slide1.xml.rels':
        '<Relationships><Relationship Target="../notesSlides/notesSlide1.xml"/></Relationships>',
      'ppt/notesSlides/notesSlide1.xml':
        '<p:notes><a:p><a:r><a:t>Say the pager rotates weekly.</a:t></a:r></a:p></p:notes>',
    });
    const read = text('deck.pptx', pptx);
    expect(read.indexOf('First')).toBeLessThan(read.indexOf('Second'));
    expect(read.indexOf('Second')).toBeLessThan(read.indexOf('Last'));
    expect(read).toContain('### Slide 1\nFirst\n\nSpeaker notes: Say the pager rotates weekly.');
  });

  it('give a Visio drawing and OpenDocument files their text', async () => {
    const vsdx = await zip({
      'visio/pages/pages.xml': '<Pages><Page Name="Flow"/></Pages>',
      'visio/pages/page1.xml':
        '<PageContents><Shape><Text>Client</Text></Shape><Shape><Text><cp IX="0"/>Gateway</Text></Shape></PageContents>',
    });
    expect(text('flow.vsdx', vsdx)).toBe('### Page: Flow\n- Client\n- Gateway');
    const odt = await zip({
      'content.xml': '<office:text><text:h>Title</text:h><text:p>Body<text:s/>text</text:p></office:text>',
    });
    expect(text('notes.odt', odt)).toBe('Title\nBody text');
  });
});

describe('diagrams, which give their labels', () => {
  it('read a Gliffy diagram and a draw.io one, plain or compressed as draw.io saves it', () => {
    expect(
      gliffyLabels(JSON.stringify({ stage: { objects: [{ graphic: { Text: { html: '<p>Client</p>' } } }] } })),
    ).toEqual(['Client']);
    const model =
      '<mxGraphModel><root><mxCell id="2" value="API &lt;b&gt;Gateway&lt;/b&gt;"/><mxCell id="3" value="Billing"/></root></mxGraphModel>';
    expect(text('flow.drawio', `<mxfile><diagram name="Page-1">${model}</diagram></mxfile>`)).toContain(
      '- API Gateway\n- Billing',
    );
    const packed = zlib.deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64');
    expect(
      text('flow', `<mxfile><diagram name="Page-1">${packed}</diagram></mxfile>`, 'application/vnd.jgraph.mxfile'),
    ).toContain('- Billing');
  });

  it('read SVG text and BPMN names', () => {
    expect(text('chart.svg', '<svg><title>Load</title><text x="1">Peak <tspan>4200</tspan></text></svg>')).toContain(
      '- Peak 4200',
    );
    expect(
      text('order.bpmn', '<bpmn:definitions name="x"><bpmn:task id="a" name="Check stock"/></bpmn:definitions>'),
    ).toContain('- task: Check stock');
  });
});

describe('other common formats', () => {
  it('read RTF, email, calendar files and notebooks as their text', () => {
    expect(text('memo.rtf', String.raw`{\rtf1{\fonttbl{\f0 Arial;}}\f0 Caf\'e9 opens\par at \b nine\b0.}`)).toBe(
      'Café opens\nat nine.',
    );
    const eml = [
      'From: ops@example.com',
      'Subject: Outage',
      'Content-Type: multipart/alternative; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'The gateway was down for 12 min=',
      'utes.',
      '--b--',
    ].join('\r\n');
    expect(text('outage.eml', eml)).toBe(
      'From: ops@example.com\nSubject: Outage\n\nThe gateway was down for 12 minutes.',
    );
    const ics =
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Failover drill\nDTSTART:20261101T090000Z\nDESCRIPTION:Bring the\\nrunbook\nEND:VEVENT\nEND:VCALENDAR';
    expect(text('drill.ics', ics)).toBe('### Failover drill\nStarts: 20261101T090000Z\nBring the\nrunbook');
    // eslint-disable-next-line camelcase -- a notebook's own field names
    const notebook = {
      metadata: { language_info: { name: 'python' } },
      cells: [
        { cell_type: 'markdown', source: ['# Load'] },
        { cell_type: 'code', source: 'print(4200)', outputs: [{ text: 'hidden' }] },
      ],
    };
    expect(text('load.ipynb', JSON.stringify(notebook))).toBe('# Load\n\n```python\nprint(4200)\n```');
  });

  it('read code, configuration and diagram sources as text, and a zip by its files', async () => {
    expect(text('job.py', 'print("hi")')).toBe('print("hi")');
    expect(text('flow.mmd', 'graph TD; A-->B')).toBe('graph TD; A-->B');
    const archive = await zip({ 'notes/readme.txt': 'Inside the archive.', 'logo.png': Buffer.from([1, 2, 3]) });
    expect(text('bundle.zip', archive)).toBe(
      'Files in the archive:\n- notes/readme.txt\n- logo.png\n\n### notes/readme.txt\nInside the archive.',
    );
  });
});

describe('formats the app cannot read', () => {
  it('are named with why and what to do, before and after reading', () => {
    expect(why('budget.xls')).toMatch(/older binary format.*\.xlsx/);
    expect(why('plan.pages')).toMatch(/Apple format/);
    expect(why('scan.tiff')).toMatch(/attach it as PNG or JPEG/);
    expect(why('demo.mp4')).toBe('video and audio are not sent to the AI');
    expect(why('thing.xyz')).toBe('a .xyz file, which the app does not read');
    expect(why('data.txt', Buffer.from([65, 0, 66]))).toBe('looks like a binary file');
    expect(why('broken.docx', 'not a zip')).toBe('could not be read: not a zip archive');
    expect(formatOf('budget.xls', '')).toEqual({ why: why('budget.xls') });
    expect(formatOf('limits.xlsx', '')).toEqual({ as: 'Excel' });
    expect(formatOf('source', 'application/gliffy+json')).toEqual({ as: 'Gliffy' });
  });
});

describe('a zip archive from a page', () => {
  it('is refused, not inflated whole, when its files would inflate past the limit', async () => {
    const bomb = await zip({ 'word/document.xml': Buffer.alloc(ZIP_BYTES + 1024, 0x41) });
    expect(bomb.length).toBeLessThan(ZIP_BYTES / 100);
    expect(why('bomb.docx', bomb)).toMatch(/could not be read: .*(too large|larger|exceed)/i);
  });

  it('is refused when its header understates how large a file inflates, rather than trusted', async () => {
    const liar = await zip({ 'word/document.xml': Buffer.alloc(ZIP_BYTES + 1024, 0x41) });
    // The central directory's record of the file's inflated size, set to ten bytes.
    const at = liar.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    liar.writeUInt32LE(10, at + 24);
    expect(why('liar.docx', liar)).toMatch(/could not be read/);
  });

  it('is refused when it lists more files than the limit', async () => {
    const many = await zip(
      Object.fromEntries(Array.from({ length: ZIP_ENTRIES + 1 }, (_, i) => [`f${i}.txt`, ''])),
      true,
    );
    expect(() => zipEntries(many)).toThrow(`an archive of more than ${ZIP_ENTRIES} files`);
  });
});
