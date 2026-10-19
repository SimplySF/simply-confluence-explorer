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

// Conversations: what each turn sends, what is kept, and what an upload may be (ADR-023).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import type { AiSessionView } from '../src/api/types.js';
import { extractText, historyToSend, SessionStore } from '../src/ai/sessions.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp, type TestApp } from './support/testApp.js';

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(() => fake.close());

/** A minimal one-page PDF whose page says `text`, with a correct cross-reference table. */
function pdfSaying(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const pageScope = (): { scope: { kind: string; spaceKey: string; pageId: string; title: string } } => ({
  scope: { kind: 'page', spaceKey: 'OPS', pageId: fake.page('OPS', 'On-Call Handbook').id, title: 'On-Call Handbook' },
});

async function withApp(run: (app: TestApp) => Promise<void>): Promise<void> {
  const app = await startTestApp(fake);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test('a conversation sends its history, keeps the context first and unchanged, and survives a restart', async () => {
  await withApp(async (app) => {
    const { body: created } = await app.call<AiSessionView>('POST', '/ai/sessions', pageScope());
    await app.call('POST', `/ai/sessions/${created.id}/messages`, { prompt: 'What is on this page?' });
    const { body: after } = await app.call<AiSessionView>('POST', `/ai/sessions/${created.id}/messages`, {
      prompt: 'And who owns it?',
    });

    assert.equal(after.turns.length, 4);
    assert.equal(after.turns[1].text, 'answer 1');
    const [first, second] = app.sent;
    assert.equal(first.messages.length, 1);
    assert.equal(second.messages.length, 3, 'context and question, answer, new question');
    assert.equal(
      second.messages[0].content,
      first.messages[0].content,
      'the context is byte-identical on every turn, so it can be cached',
    );
    assert.match(second.messages[0].content, /\[Page: On-Call Handbook\]/);
    assert.equal(second.messages[2].content, 'And who owns it?');

    const reloaded = new SessionStore(app.dataDir).get(created.id)!;
    assert.equal(reloaded.turns.length, 4);
  });
});

test('a value keeps its placeholder across turns, and the reply shows the real value', async () => {
  await withApp(async (app) => {
    const { body: c } = await app.call<AiSessionView>('POST', '/ai/sessions', pageScope());
    const one = await app.call('POST', `/ai/sessions/${c.id}/messages`, {
      prompt: 'Email ana.ortiz@example.com about this',
    });
    const two = await app.call<AiSessionView>('POST', `/ai/sessions/${c.id}/messages`, {
      prompt: 'Draft the email to ana.ortiz@example.com',
    });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.doesNotMatch(app.sentText(), /ana\.ortiz@example\.com/);
    assert.match(
      app.sent[1].messages.map((m) => m.content).join('\n'),
      /\[EMAIL-1\][\s\S]*\[EMAIL-1\]/,
      'the same placeholder in the history and the new turn',
    );
    assert.match(two.body.turns[3].text, /ana\.ortiz@example\.com/, 'restored in the answer');
    assert.match(two.body.turns[3].guardSummary ?? '', /email address/);
    assert.doesNotMatch(JSON.stringify(two.body), /guardState/, 'the placeholder map never reaches a browser');
  });
});

test('uploaded files become context: text as it is, HTML as Markdown, PDF as its text', async () => {
  await withApp(async (app) => {
    const { body: c } = await app.call<AiSessionView>('POST', '/ai/sessions', pageScope());
    const up = (name: string, bytes: Buffer): Promise<{ status: number; body: Record<string, unknown> }> =>
      app.call('POST', `/ai/sessions/${c.id}/files`, { name, data: bytes.toString('base64') });
    assert.equal((await up('notes.md', Buffer.from('# Notes\nRotate keys monthly.'))).status, 200);
    assert.equal((await up('policy.html', Buffer.from('<h2>Policy</h2><p>Keep <b>logs</b> 90 days.</p>'))).status, 200);
    const pdf = await up('spec.pdf', pdfSaying('Retention is 365 days'));
    assert.equal(pdf.status, 200, JSON.stringify(pdf.body));
    await app.call('POST', `/ai/sessions/${c.id}/messages`, { prompt: 'Summarise the files' });
    const context = app.sent[0].messages[0].content;
    assert.match(context, /\[File: notes\.md\][\s\S]*Rotate keys monthly/);
    assert.match(context, /## Policy[\s\S]*Keep \*\*logs\*\* 90 days/);
    assert.match(context, /\[File: spec\.pdf\][\s\S]*Retention is 365 days/);
  });
});

test('an uploaded file holding a secret stops the turn, like any other content', async () => {
  await withApp(async (app) => {
    const { body: c } = await app.call<AiSessionView>('POST', '/ai/sessions', pageScope());
    const key = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
    await app.call('POST', `/ai/sessions/${c.id}/files`, {
      name: 'env.txt',
      data: Buffer.from(`AWS_ACCESS_KEY_ID=${key}`).toString('base64'),
    });
    const turn = await app.call('POST', `/ai/sessions/${c.id}/messages`, { prompt: 'What is configured?' });
    assert.equal(turn.status, 422);
    assert.equal(app.sent.length, 0);
    assert.equal(
      (await app.call<AiSessionView>('GET', `/ai/sessions/${c.id}`)).body.turns.length,
      0,
      'a refused turn is not recorded',
    );
  });
});

test('uploads that are not text are refused with a reason', async () => {
  await assert.rejects(extractText('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])), /not supported/);
  await assert.rejects(extractText('data.txt', Buffer.from([0x41, 0x00, 0x42])), /binary/);
  await assert.rejects(extractText('scan.pdf', pdfSaying('')), /no extractable text/);
});

test('history keeps the newest turns that fit, and starts with a question', () => {
  const turns = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? ('assistant' as const) : ('user' as const),
    text: `${i}`.repeat(100),
    at: '',
  }));
  const kept = historyToSend(turns, 350);
  assert.equal(kept[0].role, 'user');
  assert.deepEqual(
    kept.map((t) => t.text[0]),
    ['4', '5'],
  );
});

test('a scope must name a valid space, and a page scope a page', async () => {
  await withApp(async (app) => {
    assert.equal((await app.call('POST', '/ai/sessions', { scope: { kind: 'page', spaceKey: 'OPS' } })).status, 400);
    assert.equal((await app.call('POST', '/ai/sessions', { scope: { kind: 'space', spaceKey: '..' } })).status, 400);
    assert.equal((await app.call('GET', '/ai/sessions/not-a-uuid')).status, 400);
  });
});

test('a question the person stops adds nothing to the conversation, even when the answer arrives afterwards', async () => {
  let answered = (): void => undefined;
  const late = new Promise<void>((resolve) => (answered = resolve));
  // The answer ignores the stop and comes anyway, as a provider that already had the request might.
  const app = await startTestApp(fake, async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    answered();
    return 'an answer nobody is waiting for';
  });
  try {
    const { body: c } = await app.call<AiSessionView>('POST', '/ai/sessions', pageScope());
    const stop = new AbortController();
    const asked = fetch(`${app.base}/ai/sessions/${c.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'A question with a typo' }),
      signal: stop.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    await assert.rejects(asked);
    await late;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await app.call<AiSessionView>('GET', `/ai/sessions/${c.id}`)).body.turns.length, 0);
    const audit = fs.readFileSync(path.join(app.dataDir, 'data', 'ai-audit.jsonl'), 'utf8');
    assert.match(audit, /"outcome":"stopped"/);
  } finally {
    await app.close();
  }
});
