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
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { AiSessionView, BatchProgress } from '../src/api/types.js';
import type { RetrievedContext } from '../src/spaces/contextRetriever.js';
import type { GuardedPayload } from '../src/ai/guard.js';
import { extractText, historyToSend, SessionStore } from '../src/ai/sessions.js';
import { expectations } from '../../../test-env/fixtures/dataset.mjs';
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

/** The test spaces hold a few hundred characters, so a limit this low makes a chat retrieve from them as from a large space. */
const RETRIEVING = 300;

async function withApp(run: (app: TestApp) => Promise<void>, contextChars?: number): Promise<void> {
  const app = await startTestApp(fake, undefined, {}, { contextChars });
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
    assert.equal(first.turns.at(-1)?.corpus?.mode, 'retrieved');
    const second = await ask(app, c.id, 'And how many days remote per week?');
    assert.ok(sources(second).includes('Travel Policy'), 'the earlier source is kept');
    assert.ok(sources(second).includes('Remote Work Policy'), sources(second).join(', '));
    assert.equal(second.title, 'Which flights can be booked in economy?');
  }, RETRIEVING);
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
  }, RETRIEVING);
});

/** The retriever on an app's data directory, as the routes build it. */
async function retriever(app: TestApp): Promise<{
  context: (
    q: { question: string; previous?: string; keep?: Array<{ pageId: string; index?: number }> },
    budget?: number,
  ) => Promise<RetrievedContext>;
}> {
  const { retrieveContext } = await import('../src/spaces/contextRetriever.js');
  const { SpaceStore } = await import('../src/spaces/spaceStore.js');
  const { ExclusionManager } = await import('../src/spaces/exclusionManager.js');
  const { SearchIndex } = await import('../src/spaces/searchIndex.js');
  const exclusions = new ExclusionManager(app.dataDir, () => undefined);
  const store = new SpaceStore(app.dataDir, exclusions, () => undefined);
  const deps = { store, exclusions, index: new SearchIndex(store), dataDir: app.dataDir };
  return {
    context: async (q, budget = RETRIEVING) => {
      await deps.index.ready('PEOPLE');
      return retrieveContext('PEOPLE', await store.visiblePages('PEOPLE'), q, deps, { budget, outline: true });
    },
  };
}

test('a corpus that fits is read in full, and a larger one sends only the sections it retrieves, within the limit', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const { context } = await retriever(app);
    const full = await context({ question: 'anything' }, 400_000);
    assert.equal(full.corpus.mode, 'full');
    assert.equal(full.selectedPages.length, full.corpus.pages);
    const small = await context({ question: 'policy remote travel economy' }, 120);
    assert.equal(small.corpus.mode, 'retrieved');
    assert.ok(small.overflow.length > 0, 'something did not fit');
    const body = small.contextMarkdown.slice(small.contextMarkdown.indexOf('---'));
    assert.ok(body.length <= 120 + 200, `${body.length}`);
    assert.ok(
      small.selectedPages.every((p) => p.sections?.length),
      'each page names the sections read',
    );
  });
});

test('chosen pages are directories, tags and pages, resolved on every turn; each must be allowed and in the space', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const id = (title: string): string => fake.page('PEOPLE', title).id;
    const create = (scope: Record<string, unknown>): Promise<{ status: number; body: AiSessionView }> =>
      app.call<AiSessionView>('POST', '/ai/sessions', { scope: { kind: 'pages', spaceKey: 'PEOPLE', ...scope } });
    assert.equal((await create({ pageIds: [id('Salary Bands')] })).status, 403);
    assert.equal((await create({ dirs: [id('Salary Bands')] })).status, 403);
    assert.equal((await create({ pageIds: [fake.page('OPS', 'On-Call Handbook').id] })).status, 400);
    assert.equal((await create({ pageIds: ['../x'] })).status, 400);
    assert.equal((await create({ pageIds: [] })).status, 400);
    const many = Array.from({ length: 10_001 }, (_, i) => `${i + 1}`);
    assert.equal((await create({ pageIds: many })).status, 400);

    const chosen = await create({ dirs: [id('Policies')], pageIds: [id('Benefits Overview')] });
    assert.equal(chosen.status, 200);
    const answered = await ask(app, chosen.body.id, 'Which flights can be booked in economy?');
    assert.deepEqual(sources(answered), ['Benefits Overview', 'Policies', 'Remote Work Policy', 'Travel Policy']);
    // A page excluded after it was chosen is no longer read, though its directory still is.
    await app.call('POST', '/space-cache/PEOPLE/ignore', { patterns: ['Policies/Travel Policy'], purge: false });
    assert.deepEqual(sources(await ask(app, chosen.body.id, 'And business class?')), [
      'Benefits Overview',
      'Policies',
      'Remote Work Policy',
    ]);

    const tagged = await create({ tags: ['People'] });
    assert.deepEqual(tagged.body.scope.tags, ['people']);
  });
});

test('a Space chat changes between the whole space and chosen pages, with the same checks', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const c = await spaceChat(app);
    const change = (scope: unknown): Promise<{ status: number; body: AiSessionView }> =>
      app.call<AiSessionView>('PATCH', `/ai/sessions/${c.id}`, { scope });
    const benefits = fake.page('PEOPLE', 'Benefits Overview').id;
    assert.equal((await change({ kind: 'pages', pageIds: [fake.page('PEOPLE', 'Salary Bands').id] })).status, 403);
    const narrowed = await change({ kind: 'pages', pageIds: [benefits], tags: ['no-such-tag'] });
    assert.deepEqual(narrowed.body.scope, {
      kind: 'pages',
      spaceKey: 'PEOPLE',
      pageIds: [benefits],
      tags: ['no-such-tag'],
    });
    assert.deepEqual(sources(await ask(app, c.id, 'Which flights can be booked in economy?')), ['Benefits Overview']);
    assert.equal((await change({ kind: 'space' })).body.scope.kind, 'space');
    const page = await app.call<AiSessionView>('POST', '/ai/sessions', pageScope());
    assert.equal((await app.call('PATCH', `/ai/sessions/${page.body.id}`, { scope: { kind: 'space' } })).status, 400);
    const named = await app.call<AiSessionView>('PATCH', `/ai/sessions/${c.id}`, { title: '#benefits' });
    assert.equal(named.body.title, '#benefits');
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

test('a follow-up finds its sections through the question before it, and through the sections the last answers read', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const { context } = await retriever(app);
    const titles = async (q: Parameters<typeof context>[0]): Promise<string[]> =>
      (await context(q)).selectedPages.map((p) => p.title);
    const vague = 'and who signs it off';
    assert.ok(!(await titles({ question: vague })).includes('Travel Policy'));
    assert.ok(
      (await titles({ question: vague, previous: 'Which flights can be booked in economy?' })).includes(
        'Travel Policy',
      ),
    );
    const travel = fake.page('PEOPLE', 'Travel Policy').id;
    assert.ok((await titles({ question: vague, keep: [{ pageId: travel }] })).includes('Travel Policy'));
    assert.ok((await titles({ question: vague, keep: [{ pageId: travel, index: 0 }] })).includes('Travel Policy'));
  });
});

// The context engine (ADR-048): with summaries, the AI chooses what to read from metadata alone.

async function summarise(app: TestApp, spaceKey: string): Promise<void> {
  const { body } = await app.call<{ jobId: string }>('POST', `/space-cache/${spaceKey}/metadata/generate`, {});
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
    const { body: p } = await app.call<{ status: string }>('GET', `/space-cache/metadata/status/${body.jobId}`);
    if (p.status !== 'running' && p.status !== 'pending') return;
    // eslint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const choosing = (p: GuardedPayload): boolean => p.system.includes('choosing which sections of Confluence pages');
const textOf = (p: GuardedPayload): string => [p.system, ...p.messages.map((m) => m.content)].join('\n');

test('a whole-space question lets the AI choose its sections from their summaries, never their text', async () => {
  let choice = '';
  const app = await startTestApp(
    fake,
    (payload) => {
      if (payload.system.includes('return a JSON object')) {
        const about = (title: string): string =>
          title.includes('Policy') ? 'Rules for travel and remote work.' : `About ${title}.`;
        const pages = [...payload.messages[0].content.matchAll(/^=== PAGE (\S+): (.+) ===$/gm)];
        if (pages.length)
          return JSON.stringify({
            pages: pages.map((m) => ({
              id: m[1],
              summary: about(m[2]),
              tags: [],
              documentType: 'policy',
              systemsMentioned: [],
            })),
          });
        const title = /# Document Title: (.+)/.exec(payload.messages[0].content)?.[1] ?? '';
        return JSON.stringify({ summary: about(title), tags: [], documentType: 'policy', systemsMentioned: [] });
      }
      if (choosing(payload)) return choice;
      return 'an answer';
    },
    {},
    { contextChars: RETRIEVING },
  );
  try {
    await syncSpace(app, 'PEOPLE');
    await summarise(app, 'PEOPLE');
    const travel = fake.page('PEOPLE', 'Travel Policy').id;
    const remote = fake.page('PEOPLE', 'Remote Work Policy').id;
    // Interview Guide matches nothing in the question, so it is not offered, and choosing it reads nothing.
    const guide = fake.page('PEOPLE', 'Interview Guide').id;
    choice = JSON.stringify({
      sections: [
        { id: `${remote}#0`, why: 'remote rules' },
        { id: `${guide}#0`, why: 'not offered' },
      ],
    });
    const c = await spaceChat(app);
    const before = app.sent.length;
    const answered = await ask(app, c.id, 'What are the travel and remote work policies?');
    const asked = app.sent.slice(before).filter(choosing);
    assert.equal(asked.length, 1, 'one request chooses the sections');
    assert.match(textOf(asked[0]), /Rules for travel and remote work\./);
    assert.match(textOf(asked[0]), new RegExp(`${travel}#0`));
    assert.doesNotMatch(textOf(asked[0]), new RegExp(`${guide}#0 \\|`));
    assert.doesNotMatch(textOf(asked[0]), /Flights over 6h|Up to 5 days remote/, 'no page text is sent to choose');
    const turn = answered.turns.at(-1)!;
    assert.deepEqual(
      turn.matchedPages?.map((p) => [p.title, p.why]),
      [['Remote Work Policy', 'remote rules']],
      'only offered pages are read',
    );
    assert.ok((turn.considered ?? 0) >= 2);

    choice = 'I would read the travel policy.';
    const fallback = await ask(app, c.id, 'Which flights can be booked in economy?');
    assert.ok(sources(fallback).includes('Travel Policy'), 'an unreadable choice falls back to the search');

    await app.call('POST', '/space-cache/PEOPLE/ignore', { patterns: ['Policies/Travel Policy'], purge: false });
    const later = app.sent.length;
    await ask(app, c.id, 'And business class flights?');
    for (const p of app.sent.slice(later).filter(choosing)) assert.doesNotMatch(textOf(p), /Travel Policy/);
  } finally {
    await app.close();
  }
});

test('without summaries, a whole-space question reads the top search results and asks nothing first', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const c = await spaceChat(app);
    const before = app.sent.length;
    const answered = await ask(app, c.id, 'Which flights can be booked in economy?');
    assert.equal(app.sent.slice(before).filter(choosing).length, 0);
    assert.ok(sources(answered).includes('Travel Policy'));
  }, RETRIEVING);
});

test('with embeddings, a question finds a section by its meaning when none of its words are in it', async () => {
  for (const embeddings of [false, true]) {
    // eslint-disable-next-line no-await-in-loop -- the two apps run one after the other
    const app = await startTestApp(fake, undefined, {}, { contextChars: 2000, embeddings });
    try {
      /* eslint-disable no-await-in-loop -- as above */
      await syncSpace(app, 'PLAT');
      await summarise(app, 'PLAT');
      const c = await spaceChat(app, 'PLAT');
      const answered = await ask(app, c.id, 'Everything went offline');
      /* eslint-enable no-await-in-loop */
      assert.equal(sources(answered).includes('Incident Response'), embeddings, sources(answered).join(', '));
      if (embeddings) {
        const asked = app.embedded.at(-1)?.messages.map((m) => m.content);
        assert.deepEqual(asked, ['Everything went offline'], 'the question is embedded through the guard');
        for (const title of expectations.PLAT.excluded)
          assert.doesNotMatch(
            app.embedded.map(textOf).join('\n'),
            new RegExp(title),
            'an excluded page is never embedded',
          );
      }
    } finally {
      // eslint-disable-next-line no-await-in-loop -- as above
      await app.close();
    }
  }
});

test('an excluded page is left out of a corpus, and an excluded directory refuses its chat', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const { corpusPages } = await import('../src/spaces/corpus.js');
    const { SpaceStore } = await import('../src/spaces/spaceStore.js');
    const { ExclusionManager } = await import('../src/spaces/exclusionManager.js');
    const exclusions = new ExclusionManager(app.dataDir, () => undefined);
    const store = new SpaceStore(app.dataDir, exclusions, () => undefined);
    const id = (title: string): string => fake.page('PEOPLE', title).id;
    const before = app.sent.length;
    const { body: c } = await app.call<AiSessionView>('POST', '/ai/sessions', {
      scope: { kind: 'branch', spaceKey: 'PEOPLE', pageId: id('Internal') },
    });
    const refused = await app.call('POST', `/ai/sessions/${c.id}/messages`, { prompt: 'Summarise these' });
    assert.equal(refused.status, 403);
    assert.equal(app.sent.length, before, 'nothing is sent');

    // Excluded after it was synced, so its copy is still on disk.
    await app.call('POST', '/space-cache/PEOPLE/ignore', { patterns: ['Policies/Travel Policy'], purge: false });
    const titles = (
      await corpusPages(store, exclusions, {
        kind: 'pages',
        spaceKey: 'PEOPLE',
        pageIds: [id('Travel Policy'), id('Remote Work Policy')],
      })
    ).map((p) => p.title);
    assert.deepEqual(titles, ['Remote Work Policy']);
  });
});

test('summary coverage says whether chosen pages fit one request, so the chat can say how it reads them', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const coverage = async (body: unknown): Promise<unknown> =>
      (await app.call('POST', '/space-cache/PEOPLE/metadata/coverage', body)).body;
    expect(await coverage({})).toMatchObject({ fits: false });
    expect(await coverage({ pageIds: [fake.page('PEOPLE', 'Benefits Overview').id] })).toMatchObject({ fits: true });
  }, RETRIEVING);
});

const isReview = (p: GuardedPayload): boolean => textOf(p).includes('Find what a maintainer should fix');

async function finished(app: TestApp, jobId: string): Promise<BatchProgress> {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
    const { body } = await app.call<BatchProgress>('GET', `/ai/batches/${jobId}`);
    if (body.status !== 'running' && body.status !== 'pending') return body;
    // eslint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a review of more pages than one request carries reads them in batches and merges the suggestions', async () => {
  const app = await startTestApp(
    fake,
    (payload) => {
      const first = /## \[Page: ([^\]]+)\]/.exec(textOf(payload))?.[1] ?? '';
      return isReview(payload)
        ? JSON.stringify({
            findings: [
              { kind: 'clarity', pages: [first], detail: `Unclear: ${first}`, suggestion: 'Say who it is for.' },
            ],
          })
        : 'an answer';
    },
    {},
    { contextChars: 900 },
  );
  try {
    await syncSpace(app, 'PEOPLE');
    const c = await spaceChat(app);
    const before = app.sent.length;
    const started = await app.call<AiSessionView & { batch?: BatchProgress }>('POST', `/ai/sessions/${c.id}/suggest`, {
      kind: 'review',
    });
    assert.ok(started.body.batch, 'a batch job is started');
    const done = await finished(app, started.body.batch.jobId);
    // The limit is above any one page of the space and below all of them together.
    assert.equal(done.status, 'completed');
    assert.ok(done.total > 1, `${done.total} batches`);
    const sent = app.sent.slice(before);
    assert.equal(sent.filter(isReview).length, done.total);
    // Every page a batch reads is marked, so the engine could check it arrived whole.
    for (const p of sent.filter(isReview)) {
      const text = textOf(p);
      assert.equal((text.match(/⟦c\d+⟧/g) ?? []).length, (text.match(/## \[Page: /g) ?? []).length);
    }
    for (const title of expectations.PEOPLE.excluded)
      assert.doesNotMatch(sent.map(textOf).join('\n'), new RegExp(title));
    const { body: s } = await app.call<AiSessionView>('GET', `/ai/sessions/${c.id}`);
    const turn = s.turns.at(-1)!;
    assert.match(s.turns.at(-2)!.text, /^Review these \d+ pages for problems$/);
    assert.equal(turn.corpus?.mode, 'batched');
    assert.equal(turn.findings?.length, done.total, 'one suggestion from each batch');
    assert.deepEqual(Object.keys(turn.pageIds ?? {}).sort(), turn.findings.map((f) => f.pages[0]).sort());

    // A page holding a secret is left out of its batch and named, as in any request.
    await syncSpace(app, 'OPS');
    const ops = await spaceChat(app, 'OPS');
    const opsBefore = app.sent.length;
    const { body: opsStarted } = await app.call<AiSessionView & { batch: BatchProgress }>(
      'POST',
      `/ai/sessions/${ops.id}/suggest`,
      { kind: 'review' },
    );
    await finished(app, opsStarted.batch.jobId);
    const { body: opsChat } = await app.call<AiSessionView>('GET', `/ai/sessions/${ops.id}`);
    assert.match(opsChat.turns.at(-1)?.guardSummary ?? '', /Deploy Notes/);
    assert.doesNotMatch(app.sent.slice(opsBefore).map(textOf).join('\n'), /\[Page: Deploy Notes\]/);
  } finally {
    await app.close();
  }
});

test('stopping a batched review ends it and leaves nothing in the conversation', async () => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const app = await startTestApp(
    fake,
    async (payload, _n, signal) => {
      if (!isReview(payload)) return 'an answer';
      await Promise.race([
        held,
        new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      ]);
      return '{"findings":[]}';
    },
    {},
    { contextChars: RETRIEVING },
  );
  try {
    await syncSpace(app, 'PEOPLE');
    const c = await spaceChat(app);
    const { body } = await app.call<AiSessionView & { batch: BatchProgress }>('POST', `/ai/sessions/${c.id}/suggest`, {
      kind: 'review',
    });
    assert.equal(
      (await app.call<{ batch: BatchProgress }>('GET', `/ai/sessions/${c.id}/batch`)).body.batch.jobId,
      body.batch.jobId,
    );
    const again = await app.call('POST', `/ai/sessions/${c.id}/suggest`, { kind: 'review' });
    assert.equal(again.status, 409, 'one review at a time in a chat');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual((await app.call('POST', `/ai/batches/${body.batch.jobId}/cancel`)).body, { cancelled: true });
    release();
    const stopped = await finished(app, body.batch.jobId);
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.error, undefined, 'stopping is not an error');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await app.call<AiSessionView>('GET', `/ai/sessions/${c.id}`)).body.turns.length, 0);
    assert.deepEqual((await app.call('GET', `/ai/sessions/${c.id}/batch`)).body, { batch: null });
  } finally {
    await app.close();
  }
});

test('a corpus judged to fit is never read with pages left out for size; it is retrieved from instead', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const { context } = await retriever(app);
    // Budgets around the size of the pages' text alone, which leaves out the frontmatter each page carries.
    for (const budget of [300, 400, 600, 900, 1500, 2500, 4000]) {
      // eslint-disable-next-line no-await-in-loop -- each budget is checked in turn
      const r = await context({ question: 'policy remote travel' }, budget);
      assert.ok(
        !(r.corpus.mode === 'full' && r.overflow.length > 0),
        `${budget}: read in part: ${r.overflow.join(', ')}`,
      );
    }
  });
});

test('a batch whose reply cannot be read is asked again, then named as not reviewed', async () => {
  let asked = 0;
  const app = await startTestApp(
    fake,
    (payload) => {
      if (!isReview(payload)) return 'an answer';
      asked++;
      return 'Here are some thoughts, but no JSON.';
    },
    {},
    { contextChars: 900 },
  );
  try {
    await syncSpace(app, 'PEOPLE');
    const c = await spaceChat(app);
    const { body } = await app.call<AiSessionView & { batch: BatchProgress }>('POST', `/ai/sessions/${c.id}/suggest`, {
      kind: 'review',
    });
    const done = await finished(app, body.batch.jobId);
    assert.equal(asked, done.total * 2, 'each batch is asked twice');
    const { body: s } = await app.call<AiSessionView>('GET', `/ai/sessions/${c.id}`);
    assert.match(s.turns.at(-1)?.guardSummary ?? '', /Not reviewed, because the AI's reply could not be read twice: /);
    assert.equal(s.turns.at(-1)?.findings?.length, 0);
  } finally {
    await app.close();
  }
});

test('an answer built on pages that share few words with the question says its matches are weak', async () => {
  await withApp(async (app) => {
    await syncSpace(app, 'PEOPLE');
    const c = await spaceChat(app);
    const weak = await ask(app, c.id, 'zebra quantum festival tickets');
    assert.equal(weak.turns.at(-1)?.weakMatch, true);
    const strong = await ask(app, c.id, 'Which flights can be booked in economy?');
    assert.equal(strong.turns.at(-1)?.weakMatch, undefined);
  }, RETRIEVING);
});

test('a question being answered reports the step it is on, and none once answered', async () => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const app = await startTestApp(
    fake,
    async (payload) => {
      if (!payload.system.includes('choosing which sections')) await held;
      return 'an answer';
    },
    {},
    { contextChars: RETRIEVING },
  );
  try {
    await syncSpace(app, 'PEOPLE');
    const c = await spaceChat(app);
    const asked = ask(app, c.id, 'Which flights can be booked in economy?');
    let activity: { step: string | null } = { step: null };
    for (let i = 0; i < 50 && activity.step !== 'Writing the answer'; i++) {
      // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
      await new Promise((resolve) => setTimeout(resolve, 10));
      // eslint-disable-next-line no-await-in-loop -- as above
      activity = (await app.call<{ step: string | null }>('GET', `/ai/sessions/${c.id}/activity`)).body;
    }
    assert.equal(activity.step, 'Writing the answer');
    release();
    await asked;
    assert.deepEqual((await app.call('GET', `/ai/sessions/${c.id}/activity`)).body, { step: null });
  } finally {
    await app.close();
  }
});
