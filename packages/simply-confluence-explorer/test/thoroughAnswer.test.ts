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

// Thorough answers: a question read over many sections in batches, whose notes are combined into one
// answer, with every batch accounted for (design doc 0008).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSessionView, BatchProgress } from '../src/api/types.js';
import type { GuardedPayload } from '../src/ai/guard.js';
import { expectations } from '../../../test-env/fixtures/dataset.mjs';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp, type TestApp } from './support/testApp.js';

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(() => fake.close());

const textOf = (p: GuardedPayload): string => [p.system, ...p.messages.map((m) => m.content)].join('\n');
const isNotes = (p: GuardedPayload): boolean => textOf(p).includes('You are reading one batch');
const isCombine = (p: GuardedPayload): boolean => textOf(p).includes('Answer the question below from the notes');
const QUESTION = 'What do the policies, benefits and interviews say about travel and remote work?';

async function sync(app: TestApp, key: string): Promise<void> {
  const { body } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey: key });
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
    const { body: p } = await app.call<{ status: string }>('GET', `/space-cache/sync/status/${body.jobId}`);
    if (p.status !== 'running' && p.status !== 'pending') return;
  }
}

async function finished(app: TestApp, jobId: string): Promise<BatchProgress> {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
    const { body } = await app.call<BatchProgress>('GET', `/ai/batches/${jobId}`);
    if (body.status !== 'running' && body.status !== 'pending') return body;
    // eslint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function askThoroughly(app: TestApp, spaceKey = 'PEOPLE'): Promise<AiSessionView & { batch?: BatchProgress }> {
  const { body: c } = await app.call<AiSessionView>('POST', '/ai/sessions', { scope: { kind: 'space', spaceKey } });
  const { body } = await app.call<AiSessionView & { batch?: BatchProgress }>('POST', `/ai/sessions/${c.id}/messages`, {
    prompt: QUESTION,
    thorough: true,
  });
  return body;
}

describe('a thorough answer', () => {
  it('reads its sections in batches, combines every batch’s notes, and says what each batch sent', async () => {
    let batch = 0;
    const app = await startTestApp(
      fake,
      (payload) => {
        if (isCombine(payload)) return `Combined ${(textOf(payload).match(/## Notes from batch/g) ?? []).length} notes`;
        if (!isNotes(payload)) return 'an answer';
        // Every other batch finds nothing, which counts as read with nothing to add.
        return ++batch % 2 ? `Note ${batch} [Travel Policy › Flights]` : 'NOTHING RELEVANT';
      },
      {},
      { contextChars: 300 },
    );
    try {
      await sync(app, 'PEOPLE');
      const before = app.sent.length;
      const started = await askThoroughly(app);
      expect(started.batch?.kind).toBe('answer');
      const done = await finished(app, started.batch!.jobId);
      expect(done.status).toBe('completed');
      expect(done.total).toBeGreaterThan(1);
      const sent = app.sent.slice(before);
      expect(sent.filter(isNotes)).toHaveLength(done.total);
      expect(sent.filter(isCombine)).toHaveLength(1);
      // Each section a batch reads is marked, so the engine could check it arrived whole.
      for (const p of sent.filter(isNotes)) {
        const text = textOf(p);
        expect(text).toContain('### ');
        expect((text.match(/⟦c\d+⟧ ### /g) ?? []).length).toBe((text.match(/### /g) ?? []).length);
      }
      for (const title of expectations.PEOPLE.excluded) expect(sent.map(textOf).join('\n')).not.toContain(title);

      const { body: s } = await app.call<AiSessionView>('GET', `/ai/sessions/${started.id}`);
      const [question, answer] = s.turns.slice(-2);
      expect(question.text).toBe(QUESTION);
      expect(answer.text).toBe(`Combined ${Math.ceil(done.total / 2)} notes`);
      expect(answer.corpus).toMatchObject({ mode: 'retrieved', batches: done.total });
      const read = (answer.matchedPages ?? []).reduce((n, p) => n + (p.sections?.length ?? 0), 0);
      expect(answer.sent?.sections).toBe(read);
      expect(answer.considered).toBe(done.sections);
      expect(answer.traceId).toBe(done.traceId);
    } finally {
      await app.close();
    }
  });

  it('asks a batch again when its reply is empty, then names its pages as not read', async () => {
    let notes = 0;
    const app = await startTestApp(
      fake,
      (payload) => {
        if (isCombine(payload)) return 'Combined';
        if (!isNotes(payload)) return 'an answer';
        notes++;
        return notes <= 2 ? '' : 'A note';
      },
      {},
      { contextChars: 300 },
    );
    try {
      await sync(app, 'PEOPLE');
      const started = await askThoroughly(app);
      const done = await finished(app, started.batch!.jobId);
      expect(done.status).toBe('completed');
      expect(notes).toBe(done.total + 1);
      const { body: s } = await app.call<AiSessionView>('GET', `/ai/sessions/${started.id}`);
      expect(s.turns.at(-1)!.guardSummary).toMatch(/Not read, because the AI's reply could not be read twice: \w/);
    } finally {
      await app.close();
    }
  });

  it('is answered at once when one request reads the chat’s pages in full', async () => {
    const app = await startTestApp(fake, () => 'an answer');
    try {
      await sync(app, 'PEOPLE');
      const answered = await askThoroughly(app);
      expect(answered.batch).toBeUndefined();
      expect(answered.turns.at(-1)).toMatchObject({ text: 'an answer', corpus: { mode: 'full' } });
    } finally {
      await app.close();
    }
  });
});
