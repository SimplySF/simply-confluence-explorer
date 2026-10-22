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

// A page's attachments are read with it (ADR-066): its text attachments reach the AI wherever the
// page does, pass the leak guard like its text, and never leave the machine for an excluded page.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AiSessionView,
  AttachmentsReport,
  BatchProgress,
  BranchRun,
  SessionTurn,
  SyncProgress,
} from '../src/api/types.js';
import type { GuardedPayload } from '../src/ai/guard.js';
import { gliffyLabels } from '../src/spaces/documentText.js';
import { pdfSaying } from './support/pdf.js';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { workbook } from './support/zipFiles.js';
import { startTestApp, type TestApp } from './support/testApp.js';

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(() => fake.close());

const NOTES = 'Capacity planning notes for 2026.';

/** Answers a review with one suggestion on Architecture Overview, and an edit with a small change. */
const reviewer = (payload: GuardedPayload): string => {
  const text = [payload.system, ...payload.messages.map((m) => m.content)].join('\n');
  if (text.includes('<<<PROPOSED_MARKDOWN>>>'))
    return '<<<CRITIQUE>>>\n- None\n<<<CHANGELOG>>>\n- Noted capacity\n<<<PROPOSED_MARKDOWN>>>\nCapacity is planned yearly.';
  if (payload.messages.at(-1)?.content.includes('"findings"'))
    return JSON.stringify({
      findings: [{ kind: 'depth', pages: ['Architecture Overview'], detail: 'Say how capacity is planned' }],
    });
  return 'An answer.';
};

async function withSynced(run: (app: TestApp) => Promise<void>, spaceKey = 'PLAT'): Promise<void> {
  const app = await startTestApp(fake, reviewer);
  try {
    const { body } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey });
    for (let s = 'running'; s === 'running' || s === 'pending';)
      // eslint-disable-next-line no-await-in-loop -- polling waits for the sync
      s = (await app.call<SyncProgress>('GET', `/space-cache/sync/status/${body.jobId}`)).body.status;
    await run(app);
  } finally {
    await app.close();
  }
}
const pageChat = async (app: TestApp, title: string): Promise<AiSessionView> =>
  (
    await app.call<AiSessionView>('POST', '/ai/sessions', {
      scope: { kind: 'page', spaceKey: 'PLAT', pageId: fake.page('PLAT', title).id },
    })
  ).body;
const attachment = (app: TestApp, name: string): string =>
  path.join(
    app.dataDir,
    'spaces',
    'PLAT',
    'pages',
    'Platform Engineering Home',
    'Architecture Overview_attachments',
    name,
  );

describe("a page's text attachments", () => {
  it('reach the AI with the page in a chat, where they were never read', async () => {
    await withSynced(async (app) => {
      const chat = await pageChat(app, 'Architecture Overview');
      await app.call('POST', `/ai/sessions/${chat.id}/messages`, { prompt: 'What does the capacity note say?' });
      expect(app.sentText()).toContain('## Attachment: capacity-notes.txt');
      expect(app.sentText()).toContain(NOTES);
      // An image is not text; it is never sent as characters.
      expect(app.sentText()).not.toContain('## Attachment: architecture-diagram.png');
    });
  });

  it('are found by a question about the space, as sections of their page', async () => {
    await withSynced(async (app) => {
      const chat = (
        await app.call<AiSessionView>('POST', '/ai/sessions', { scope: { kind: 'space', spaceKey: 'OPS' } })
      ).body;
      const { body } = await app.call<AiSessionView>('POST', `/ai/sessions/${chat.id}/messages`, {
        prompt: 'What are the cpu and mem figures for gateway and billing?',
      });
      expect(body.turns.at(-1)?.matchedPages?.map((p) => p.title)).toContain('Capacity Planning');
      expect(app.sentText()).toContain('gateway,4,8');
    }, 'OPS');
  });

  it('are read by the AI index with their page', async () => {
    await withSynced(async (app) => {
      const id = fake.page('PLAT', 'Architecture Overview').id;
      await app.call('POST', `/space-cache/PLAT/pages/${id}/metadata/generate`, {});
      expect(app.sentText()).toContain(NOTES);
    });
  });

  it('are given to the model writing an edit, to read but not to edit', async () => {
    await withSynced(async (app) => {
      const chat = await pageChat(app, 'Architecture Overview');
      const reviewed = (await app.call<AiSessionView>('POST', `/ai/sessions/${chat.id}/suggest`, { kind: 'review' }))
        .body;
      const before = app.sent.length;
      const { body } = await app.call<BranchRun>('POST', `/ai/sessions/${chat.id}/suggestions/recommend`, {
        ids: [reviewed.suggestions![0].id],
      });
      for (let run = body; run.status === 'running';)
        // eslint-disable-next-line no-await-in-loop -- polling waits for the edit
        run = (await app.call<BranchRun>('GET', `/branches/runs/${body.id}`)).body;
      const edit = app.sent
        .slice(before)
        .map((p) => p.system)
        .find((t) => t.includes('<<<PROPOSED_MARKDOWN>>>'));
      expect(edit).toContain('never edit them or copy them into the page');
      expect(edit).toContain(NOTES);
    });
  });

  it('pass the leak guard like page text: a secret in one stops the page being sent', async () => {
    await withSynced(async (app) => {
      fs.writeFileSync(attachment(app, 'capacity-notes.txt'), `key ${['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')}\n`);
      const chat = await pageChat(app, 'Architecture Overview');
      const asked = await app.call('POST', `/ai/sessions/${chat.id}/messages`, { prompt: 'What is in the note?' });
      expect(asked.status).toBe(422);
      expect(app.sentText()).not.toContain('IOSFODNN7');
    });
  });

  it("include a Gliffy diagram's labels, which were never read because its source has no file extension", async () => {
    const page = fake.page('PLAT', 'Architecture Overview');
    const label = (html: string): unknown => ({ graphic: { type: 'Text', Text: { html } } });
    const source = {
      contentType: 'application/gliffy+json',
      stage: {
        objects: [
          {
            graphic: { type: 'Shape', Shape: { fillColor: '#ffffff' } },
            children: [label('<p><span>Client</span></p>')],
          },
          { children: [label('<p>Rate limiter &amp; cache</p>'), label('<p><span>Client</span></p>')] },
          { graphic: { type: 'Line' }, children: [label('<p>retries 3 times</p>')] },
        ],
      },
    };
    page.attachments.push({
      title: 'request-flow',
      type: 'application/gliffy+json',
      content: Buffer.from(JSON.stringify(source)),
    });
    try {
      await withSynced(async (app) => {
        const chat = await pageChat(app, 'Architecture Overview');
        await app.call('POST', `/ai/sessions/${chat.id}/messages`, { prompt: 'What does the request flow show?' });
        expect(app.sentText()).toContain(
          '## Attachment: request-flow\n\nA Gliffy diagram. Its shapes and labels, in the order the diagram holds them:\n' +
            '- Client\n- Rate limiter & cache\n- retries 3 times',
        );
        expect(app.sentText()).not.toContain('fillColor');
      });
    } finally {
      page.attachments.pop();
    }
  });

  it('name a Gliffy source that is not JSON as unread, and read one with no text as such', () => {
    expect(gliffyLabels('not json')).toBeUndefined();
    expect(gliffyLabels(JSON.stringify({ stage: { objects: [{ graphic: { type: 'Shape' } }] } }))).toEqual([]);
  });

  it('never leave the machine for a page excluded after it was synced', async () => {
    await withSynced(async (app) => {
      await app.call('POST', '/space-cache/PLAT/ignore', { patterns: ['Architecture Overview'], purge: false });
      const chat = (
        await app.call<AiSessionView>('POST', '/ai/sessions', { scope: { kind: 'space', spaceKey: 'PLAT' } })
      ).body;
      await app.call('POST', `/ai/sessions/${chat.id}/messages`, { prompt: 'What are the capacity planning notes?' });
      expect(app.sentText()).not.toContain(NOTES);
    });
  });
});

describe("a space's images", () => {
  const ask = async (app: TestApp, prompt = 'What does the diagram show?'): Promise<AiSessionView> => {
    const chat = await pageChat(app, 'Architecture Overview');
    return (await app.call<AiSessionView>('POST', `/ai/sessions/${chat.id}/messages`, { prompt })).body;
  };
  const choose = (app: TestApp, images: string): Promise<{ status: number }> =>
    app.call('POST', '/space-cache/PLAT/space-settings', { images });

  it('are never sent until the space chooses to, and the answer says how many it did not see', async () => {
    await withSynced(async (app) => {
      const answered = await ask(app);
      expect(answered.turns.at(-1)?.images).toEqual({ found: 1, sent: 0, choice: 'ask' });
      expect(app.sent.some((p) => p.images?.length)).toBe(false);
      await choose(app, 'skip');
      expect((await ask(app)).turns.at(-1)?.images).toEqual({ found: 1, sent: 0, choice: 'skip' });
      expect(app.sent.some((p) => p.images?.length)).toBe(false);
    });
  });

  it('are sent with the page once the space chooses, each named as unchecked by the leak guard', async () => {
    await withSynced(async (app) => {
      await choose(app, 'send');
      const turn = (await ask(app)).turns.at(-1)!;
      expect(turn.images).toEqual({ found: 1, sent: 1, choice: 'send' });
      expect(app.sent.at(-1)?.images?.map((i) => i.name)).toEqual(['Architecture Overview / architecture-diagram.png']);
      expect(turn.guardSummary).toContain(
        'Sent without leak-guard checks, as images: Architecture Overview / architecture-diagram.png',
      );
      expect(turn.sent?.images).toBe(1);
    });
  });

  it('go with the edit of their page and with its index run, once the space sends them', async () => {
    await withSynced(async (app) => {
      await choose(app, 'send');
      const chat = await pageChat(app, 'Architecture Overview');
      const reviewed = (await app.call<AiSessionView>('POST', `/ai/sessions/${chat.id}/suggest`, { kind: 'review' }))
        .body;
      const { body } = await app.call<BranchRun>('POST', `/ai/sessions/${chat.id}/suggestions/recommend`, {
        ids: [reviewed.suggestions![0].id],
      });
      let run = body;
      while (run.status === 'running')
        // eslint-disable-next-line no-await-in-loop -- polling waits for the edit
        run = (await app.call<BranchRun>('GET', `/branches/runs/${body.id}`)).body;
      expect(run.items[0].images).toEqual({ found: 1, sent: 1, choice: 'send' });
      const before = app.sent.length;
      await app.call(
        'POST',
        `/space-cache/PLAT/pages/${fake.page('PLAT', 'Architecture Overview').id}/metadata/generate`,
        {},
      );
      expect(app.sent.slice(before).some((p) => p.images?.length === 1)).toBe(true);
    });
  });

  it('are counted for the coverage line with the choice, and a choice that is not one is refused', async () => {
    await withSynced(async (app) => {
      const id = fake.page('PLAT', 'Architecture Overview').id;
      const { body } = await app.call<{ images: unknown }>('POST', '/space-cache/PLAT/metadata/coverage', {
        pageIds: [id],
      });
      expect(body.images).toEqual({ found: 1, choice: 'ask' });
      expect((await choose(app, 'maybe')).status).toBe(400);
    });
  });

  it('name one missing from this machine, which would have stopped the answer', async () => {
    await withSynced(async (app) => {
      await choose(app, 'send');
      fs.rmSync(attachment(app, 'architecture-diagram.png'));
      const turn = (await ask(app)).turns.at(-1)!;
      expect(turn.role).toBe('assistant');
      expect(turn.attachments?.unread).toContainEqual(
        expect.objectContaining({
          page: 'Architecture Overview',
          name: 'architecture-diagram.png',
          why: 'not on this machine: sync the space again to download it',
        }),
      );
      expect(app.sent.at(-1)?.images).toBeUndefined();
    });
  });

  it('are named as not read when the AI answered without them, where they were counted as sent', async () => {
    // As the Gemini CLI does when it gives no answer with images and is asked again without them.
    const without = (payload: GuardedPayload): string =>
      (payload.images?.length
        ? { text: 'An answer from the text.', imagesDropped: payload.images.map((i) => i.name) }
        : reviewer(payload)) as unknown as string;
    const app = await startTestApp(fake, without);
    try {
      const { body } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey: 'PLAT' });
      for (let s = 'running'; s === 'running' || s === 'pending';)
        // eslint-disable-next-line no-await-in-loop -- polling waits for the sync
        s = (await app.call<SyncProgress>('GET', `/space-cache/sync/status/${body.jobId}`)).body.status;
      await choose(app, 'send');
      const turn = (await ask(app)).turns.at(-1)!;
      expect(turn.text).toBe('An answer from the text.');
      expect(turn.images).toMatchObject({ found: 1, sent: 0 });
      expect(turn.attachments?.unread).toContainEqual(
        expect.objectContaining({
          page: 'Architecture Overview',
          name: 'architecture-diagram.png',
          why: expect.stringMatching(/not read/),
        }),
      );
      expect(turn.sent?.leftOut).toContainEqual(
        expect.objectContaining({
          kind: 'image',
          label: 'Architecture Overview / architecture-diagram.png',
          reason: 'not-read',
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('leave out one too large to send, and name it', async () => {
    await withSynced(async (app) => {
      await choose(app, 'send');
      fs.writeFileSync(attachment(app, 'architecture-diagram.png'), Buffer.alloc(6 * 1024 * 1024));
      const turn = (await ask(app)).turns.at(-1)!;
      expect(turn.images).toEqual({ found: 1, sent: 0, choice: 'send' });
      expect(app.sent.at(-1)?.images).toBeUndefined();
    });
  });
});

describe("a page's pictures in the edit view", () => {
  const picture = (app: TestApp, pageId: string, n: string): Promise<Response> =>
    fetch(`${app.base}/space-cache/PLAT/pages/${pageId}/attachments/${n}`);

  it('are served from the synced page as images, where the edit showed only a chip', async () => {
    await withSynced(async (app) => {
      const page = fake.page('PLAT', 'Architecture Overview');
      const res = await picture(app, page.id, '0');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await res.arrayBuffer())).toEqual(
        fs.readFileSync(attachment(app, 'architecture-diagram.png')),
      );
    });
  });

  it('are never a file that is not an image, one past the list, a page not synced, or an excluded page', async () => {
    await withSynced(async (app) => {
      const id = fake.page('PLAT', 'Architecture Overview').id;
      expect((await picture(app, id, '1')).status).toBe(404);
      expect((await picture(app, id, '2')).status).toBe(404);
      expect((await picture(app, id, 'readme.txt')).status).toBe(400);
      expect((await picture(app, id, 'readme.txt')).status).toBe(400);
      expect((await picture(app, fake.page('PEOPLE', 'Interviews').id, '0')).status).toBe(404);
      await app.call('POST', '/space-cache/PLAT/ignore', {
        patterns: ['Platform Engineering Home/Architecture Overview'],
        purge: false,
      });
      expect((await picture(app, id, '0')).status).toBe(404);
    });
  });

  it('are named on the edit, so each marker for an image can show it', async () => {
    await withSynced(async (app) => {
      const chat = await pageChat(app, 'Architecture Overview');
      const reviewed = (await app.call<AiSessionView>('POST', `/ai/sessions/${chat.id}/suggest`, { kind: 'review' }))
        .body;
      const { body } = await app.call<BranchRun>('POST', `/ai/sessions/${chat.id}/suggestions/recommend`, {
        ids: [reviewed.suggestions![0].id],
      });
      let run = body;
      while (run.status === 'running')
        // eslint-disable-next-line no-await-in-loop -- polling waits for the edit
        run = (await app.call<BranchRun>('GET', `/branches/runs/${body.id}`)).body;
      const parts = run.items[0].parts ?? [];
      expect(parts.filter((p) => p.picture !== undefined)).toEqual([
        expect.objectContaining({ label: 'image: architecture-diagram.png', picture: 0 }),
      ]);
    });
  });
});

describe("the account of a chat's attachments", () => {
  // Gateway Service gets a workbook, a Word file the app cannot read in its old format, and a PDF.
  async function withFiles(run: (app: TestApp) => Promise<void>): Promise<void> {
    const page = fake.page('PLAT', 'Gateway Service');
    const added = [
      {
        title: 'limits.xlsx',
        type: 'application/vnd.ms-excel',
        content: await workbook([['Limit', '4200 per tenant']]),
      },
      { title: 'legacy-notes.doc', type: 'application/msword', content: Buffer.from('old binary') },
      { title: 'sla.pdf', type: 'application/pdf', content: pdfSaying('The SLA is 99.95 percent') },
    ];
    page.attachments.push(...added);
    try {
      await withSynced(run);
    } finally {
      page.attachments.splice(-added.length);
    }
  }
  const gatewayChat = (app: TestApp): Promise<AiSessionView> => pageChat(app, 'Gateway Service');
  const question = async (app: TestApp, id: string): Promise<SessionTurn> =>
    (
      await app.call<AiSessionView>('POST', `/ai/sessions/${id}/messages`, { prompt: 'What are the limits?' })
    ).body.turns.at(-1)!;

  it('names each file it read and each it did not, with why, where an unreadable one vanished', async () => {
    await withFiles(async (app) => {
      const turn = await question(app, (await gatewayChat(app)).id);
      expect(app.sentText()).toContain('Limit,4200 per tenant');
      expect(turn.attachments?.read.map((r) => [r.name, r.as])).toEqual(
        expect.arrayContaining([
          ['limits.xlsx', 'Excel'],
          ['sla.pdf', 'PDF'],
        ]),
      );
      expect(turn.attachments?.unread).toEqual([
        expect.objectContaining({
          page: 'Gateway Service',
          name: 'legacy-notes.doc',
          why: expect.stringMatching(/older binary format/),
        }),
      ]);
      // What was sent counts what went and names what did not, rather than saying everything arrived.
      expect(turn.sent?.attachments).toBe(2);
      expect(turn.sent?.leftOut).toContainEqual(
        expect.objectContaining({ label: 'Gateway Service / legacy-notes.doc', reason: 'not-read' }),
      );
    });
  });

  it("sends a PDF's text with the first question, where it waited for the next", async () => {
    await withFiles(async (app) => {
      await question(app, (await gatewayChat(app)).id);
      expect(app.sentText()).toContain('The SLA is 99.95 percent');
    });
  });

  it('reads pages only once the chat chooses, sending no attachment and saying why', async () => {
    await withFiles(async (app) => {
      const chat = await gatewayChat(app);
      const patched = await app.call<AiSessionView>('PATCH', `/ai/sessions/${chat.id}`, { attachments: 'pages' });
      expect(patched.body.attachments).toBe('pages');
      expect((await app.call('PATCH', `/ai/sessions/${chat.id}`, { attachments: 'some' })).status).toBe(400);
      const turn = await question(app, chat.id);
      expect(app.sentText()).not.toContain('4200 per tenant');
      expect(app.sentText()).not.toContain('99.95');
      expect(turn.attachments?.choice).toBe('pages');
      expect(new Set(turn.attachments?.unread.map((u) => u.why))).toEqual(new Set(['this chat reads pages only']));
    });
  });

  it('names a file missing from this machine, which was dropped without a word', async () => {
    await withFiles(async (app) => {
      fs.rmSync(
        path.join(
          app.dataDir,
          'spaces',
          'PLAT',
          'pages',
          'Platform Engineering Home',
          'Services',
          'Gateway Service_attachments',
          'limits.xlsx',
        ),
      );
      const turn = await question(app, (await gatewayChat(app)).id);
      expect(turn.attachments?.unread).toContainEqual(
        expect.objectContaining({
          page: 'Gateway Service',
          name: 'limits.xlsx',
          why: 'not on this machine: sync the space again to download it',
        }),
      );
    });
  });

  it('leaves out a file the person unticked, its text unsent and named, while the others still go', async () => {
    await withFiles(async (app) => {
      const chat = await gatewayChat(app);
      const id = fake.page('PLAT', 'Gateway Service').id;
      const patched = await app.call<AiSessionView>('PATCH', `/ai/sessions/${chat.id}`, {
        attachments: 'include',
        leftOutFiles: [`${id}/limits.xlsx`],
      });
      expect(patched.body.leftOutFiles).toEqual([`${id}/limits.xlsx`]);
      const turn = await question(app, chat.id);
      expect(app.sentText()).not.toContain('4200 per tenant');
      expect(app.sentText()).toContain('The SLA is 99.95 percent');
      expect(turn.attachments?.unread).toContainEqual(
        expect.objectContaining({ name: 'limits.xlsx', why: 'left out by you', left: true }),
      );
      expect(turn.sent?.leftOut).toContainEqual(
        expect.objectContaining({ label: 'Gateway Service / limits.xlsx', why: 'left out by you' }),
      );
      const refused = await Promise.all(
        ['limits.xlsx', [`${id}`], [`../x/limits.xlsx`], 'x'.repeat(10)].map(
          async (bad) => (await app.call('PATCH', `/ai/sessions/${chat.id}`, { leftOutFiles: bad })).status,
        ),
      );
      expect(refused).toEqual([400, 400, 400, 400]);
    });
  });

  it('leaves out an unticked file when the chat searches its pages, where its section could still be sent', async () => {
    const page = fake.page('PLAT', 'Gateway Service');
    page.attachments.push({
      title: 'limits.xlsx',
      type: 'application/vnd.ms-excel',
      content: await workbook([['Tenant limit', 'quokka 4200 per tenant']]),
    });
    // Small enough that a chat on all of PLAT searches its sections rather than reading every page.
    const app = await startTestApp(fake, reviewer, {}, { contextChars: 3000 });
    try {
      const { body: job } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey: 'PLAT' });
      for (let s = 'running'; s === 'running' || s === 'pending';)
        // eslint-disable-next-line no-await-in-loop -- polling waits for the sync
        s = (await app.call<SyncProgress>('GET', `/space-cache/sync/status/${job.jobId}`)).body.status;
      const ask = async (leftOut: string[]): Promise<string> => {
        const chat = (
          await app.call<AiSessionView>('POST', '/ai/sessions', { scope: { kind: 'space', spaceKey: 'PLAT' } })
        ).body;
        await app.call('PATCH', `/ai/sessions/${chat.id}`, { attachments: 'include', leftOutFiles: leftOut });
        const before = app.sent.length;
        const asked = await app.call<AiSessionView>('POST', `/ai/sessions/${chat.id}/messages`, {
          prompt: 'What is the quokka tenant limit?',
        });
        expect(asked.body.turns.at(-1)?.corpus?.mode).toBe('retrieved');
        return app.sent
          .slice(before)
          .map((p) => [p.system, ...p.messages.map((m) => m.content)].join('\n'))
          .join('\n');
      };
      expect(await ask([])).toContain('quokka 4200 per tenant');
      expect(await ask([`${page.id}/limits.xlsx`])).not.toContain('quokka 4200 per tenant');
    } finally {
      await app.close();
      page.attachments.pop();
    }
  });

  it('marks a file new once the chat has chosen without it, so it is asked about again', async () => {
    await withFiles(async (app) => {
      const chat = await gatewayChat(app);
      const id = fake.page('PLAT', 'Gateway Service').id;
      const preview = async (): Promise<AttachmentsReport> =>
        (
          await app.call<{ attachments: AttachmentsReport }>('POST', '/space-cache/PLAT/metadata/coverage', {
            pageIds: [id],
            sessionId: chat.id,
          })
        ).body.attachments;
      const before = await preview();
      expect([...before.read, ...before.unread].some((e) => e.new)).toBe(false);
      await app.call('PATCH', `/ai/sessions/${chat.id}`, {
        attachments: 'include',
        attachmentsSeen: [`${id}/limits.xlsx`, `${id}/legacy-notes.doc`],
      });
      const after = await preview();
      expect([...after.read, ...after.unread].filter((e) => e.new).map((e) => e.name)).toEqual(['sla.pdf']);
    });
  });

  it("lists the attachments of chosen pages before any question, with the chat's choice", async () => {
    await withFiles(async (app) => {
      const chat = await gatewayChat(app);
      const id = fake.page('PLAT', 'Gateway Service').id;
      const preview = async (): Promise<AttachmentsReport | undefined> =>
        (
          await app.call<{ attachments?: AttachmentsReport }>('POST', '/space-cache/PLAT/metadata/coverage', {
            pageIds: [id],
            sessionId: chat.id,
          })
        ).body.attachments;
      expect(await preview()).toMatchObject({
        files: 3,
        read: expect.arrayContaining([expect.objectContaining({ name: 'limits.xlsx', as: 'Excel' })]),
        unread: [expect.objectContaining({ name: 'legacy-notes.doc' })],
      });
      expect((await preview())?.choice).toBeUndefined();
      await app.call('PATCH', `/ai/sessions/${chat.id}`, { attachments: 'pages' });
      expect((await preview())?.choice).toBe('pages');
    });
  });
});

describe('a review read in batches', () => {
  it('sends the images the space chose to send, and says what it read, where it sent none and said nothing', async () => {
    const app = await startTestApp(fake, reviewer, {}, { contextChars: 6000 });
    try {
      const { body: job } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey: 'PLAT' });
      for (let s = 'running'; s === 'running' || s === 'pending';)
        // eslint-disable-next-line no-await-in-loop -- polling waits for the sync
        s = (await app.call<SyncProgress>('GET', `/space-cache/sync/status/${job.jobId}`)).body.status;
      await app.call('POST', '/space-cache/PLAT/space-settings', { images: 'send' });
      const chat = (
        await app.call<AiSessionView>('POST', '/ai/sessions', { scope: { kind: 'space', spaceKey: 'PLAT' } })
      ).body;
      const started = await app.call<{ batch?: BatchProgress }>('POST', `/ai/sessions/${chat.id}/suggest`, {
        kind: 'review',
      });
      expect(started.body.batch).toBeDefined();
      for (let s = 'running'; s === 'running' || s === 'pending';)
        // eslint-disable-next-line no-await-in-loop -- polling waits for the batches
        s = (await app.call<BatchProgress>('GET', `/ai/batches/${started.body.batch!.jobId}`)).body.status;
      expect(app.sent.some((p) => p.images?.length === 1)).toBe(true);
      const turn = (await app.call<AiSessionView>('GET', `/ai/sessions/${chat.id}`)).body.turns.at(-1)!;
      expect(turn.images).toMatchObject({ found: 1, sent: 1, choice: 'send' });
      expect(turn.attachments?.read).toContainEqual(
        expect.objectContaining({ name: 'capacity-notes.txt', as: 'text' }),
      );
      expect(turn.sent?.images).toBe(1);
    } finally {
      await app.close();
    }
  });
});
