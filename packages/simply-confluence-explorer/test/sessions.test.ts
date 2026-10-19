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

// Space chat: conversations about a whole synced space, with pinned pages and saved names.

async function syncSpace(app: TestApp, spaceKey: string): Promise<void> {
  const { body } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey });
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
    const { body: p } = await app.call<{ status: string }>('GET', `/space-cache/sync/status/${body.jobId}`);
    if (p.status !== 'running' && p.status !== 'pending') return;
    // eslint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const spaceChat = async (app: TestApp, spaceKey = 'PEOPLE'): Promise<AiSessionView> =>
  (await app.call<AiSessionView>('POST', '/ai/sessions', { scope: { kind: 'space', spaceKey } })).body;
const ask = async (app: TestApp, id: string, prompt: string): Promise<AiSessionView> =>
  (await app.call<AiSessionView>('POST', `/ai/sessions/${id}/messages`, { prompt })).body;
const sources = (s: AiSessionView): string[] => (s.turns.at(-1)?.matchedPages ?? []).map((p) => p.title);

test('Space chat finds a page from its text alone, and a follow-up keeps the pages it was reading', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const c = await spaceChat(app);
    // "Economy" appears only in the Travel Policy's table, not in any title, label or summary.
    const first = await ask(app, c.id, 'Which flights can be booked in economy?');
    assert.ok(sources(first).includes('Travel Policy'), sources(first).join(', '));
    const second = await ask(app, c.id, 'And how many days remote per week?');
    assert.ok(sources(second).includes('Travel Policy'), 'the earlier source is kept');
    assert.ok(sources(second).includes('Remote Work Policy'), sources(second).join(', '));
    assert.equal(second.title, 'Which flights can be booked in economy?');
  });
});

test('Space chat never sends an excluded page, and holds back and names a page with a secret', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    await app.call('POST', '/space-cache/PEOPLE/ignore', { patterns: ['Policies/Travel Policy'], purge: false });
    const c = await spaceChat(app);
    const answered = await ask(app, c.id, 'Which flights can be booked in economy?');
    assert.ok(!sources(answered).includes('Travel Policy'));
    assert.doesNotMatch(app.sentText(), /Flights over 6h/);

    await syncSpace(app, 'OPS');
    const ops = await spaceChat(app, 'OPS');
    const withheld = await ask(app, ops.id, 'What do the deploy notes say?');
    assert.ok(!sources(withheld).includes('Deploy Notes'));
    assert.match(withheld.turns.at(-1)?.guardSummary ?? '', /Deploy Notes/);
  });
});

test('Space chat fills the context up to its limit and names what did not fit', async () => {
  const { retrieveSpaceContext } = await import('../src/spaces/contextRetriever.js');
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const { SpaceStore } = await import('../src/spaces/spaceStore.js');
    const { ExclusionManager } = await import('../src/spaces/exclusionManager.js');
    const { SearchIndex } = await import('../src/spaces/searchIndex.js');
    const exclusions = new ExclusionManager(app.dataDir, () => undefined);
    const store = new SpaceStore(app.dataDir, exclusions, () => undefined);
    const deps = { store, exclusions, index: new SearchIndex(store), dataDir: app.dataDir };
    const small = retrieveSpaceContext('PEOPLE', { question: 'policy remote travel economy' }, deps, 700);
    assert.ok(small.overflow.length > 0, 'something did not fit');
    assert.ok(small.contextMarkdown.length <= 800, `${small.contextMarkdown.length}`);
  });
});

test('pinned pages are sent on every turn, and alone when asked; a pinned page must be allowed and in the space', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const c = await spaceChat(app);
    const pin = (body: unknown): Promise<{ status: number; body: AiSessionView }> =>
      app.call<AiSessionView>('PATCH', `/ai/sessions/${c.id}`, body);
    assert.equal((await pin({ pinned: [fake.page('PEOPLE', 'Salary Bands').id] })).status, 403);
    assert.equal((await pin({ pinned: [fake.page('OPS', 'On-Call Handbook').id] })).status, 400);
    assert.equal((await pin({ pinned: ['../x'] })).status, 400);
    const benefits = fake.page('PEOPLE', 'Benefits Overview').id;
    const pinned = await pin({ pinned: [benefits], pinnedOnly: true, title: '#benefits' });
    assert.deepEqual(pinned.body.pinned, [benefits]);
    const answered = await ask(app, c.id, 'Which flights can be booked in economy?');
    assert.deepEqual(sources(answered), ['Benefits Overview']);
    assert.equal(answered.title, '#benefits', 'a named conversation keeps its name');
    const page = await app.call<AiSessionView>('POST', '/ai/sessions', pageScope());
    assert.equal((await app.call('PATCH', `/ai/sessions/${page.body.id}`, { pinned: [] })).status, 400);
  });
});

test('a conversation is renamed only to a name of 1 to 80 characters', async () => {
  await withApp(async (app) => {
    const c = await spaceChat(app);
    const rename = (title: unknown): Promise<{ status: number }> =>
      app.call('PATCH', `/ai/sessions/${c.id}`, { title });
    assert.equal((await rename('   ')).status, 400);
    assert.equal((await rename('x'.repeat(81))).status, 400);
    assert.equal((await rename(42)).status, 400);
    assert.equal((await rename('Release questions')).status, 200);
    assert.equal((await app.call('PATCH', '/ai/sessions/not-a-uuid', { title: 'x' })).status, 400);
  });
});

test('a follow-up finds its pages through the question before it, and through the pages the last answers used', async () => {
  const { retrieveSpaceContext } = await import('../src/spaces/contextRetriever.js');
  const { SpaceStore } = await import('../src/spaces/spaceStore.js');
  const { ExclusionManager } = await import('../src/spaces/exclusionManager.js');
  const { SearchIndex } = await import('../src/spaces/searchIndex.js');
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const exclusions = new ExclusionManager(app.dataDir, () => undefined);
    const store = new SpaceStore(app.dataDir, exclusions, () => undefined);
    const deps = { store, exclusions, index: new SearchIndex(store), dataDir: app.dataDir };
    const titles = (q: Parameters<typeof retrieveSpaceContext>[1]): string[] =>
      retrieveSpaceContext('PEOPLE', q, deps).selectedPages.map((p) => p.title);
    const vague = 'and who signs it off';
    assert.ok(!titles({ question: vague }).includes('Travel Policy'));
    assert.ok(
      titles({ question: vague, previous: 'Which flights can be booked in economy?' }).includes('Travel Policy'),
    );
    assert.ok(titles({ question: vague, keep: [fake.page('PEOPLE', 'Travel Policy').id] }).includes('Travel Policy'));
  });
});
