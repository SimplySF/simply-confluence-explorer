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

// Context meant for the model reaches it whole, or the request is refused; unfinished answers are
// reported as such (ADR-054, design doc 0008).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSessionView, SessionTurn } from '../src/api/types.js';
import { ConfiguredAi } from '../src/ai/engine.js';
import { runGeminiCli } from '../src/ai/geminiService.js';
import { OutboundGuard, type GuardedPayload } from '../src/ai/guard.js';
import { checkPayload, ContextCheckError, ManifestBuilder, summarise } from '../src/ai/manifest.js';
import { cutOffOf } from '../src/ai/providers.js';
import { AiSettingsStore } from '../src/ai/settings.js';
import { noTracer } from '../src/telemetry/tracer.js';
import { expectations } from '../../../test-env/fixtures/dataset.mjs';
import { startFakeConfluence, type FakeConfluence } from './support/fakeConfluence.js';
import { startTestApp, type TestApp } from './support/testApp.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-ctx-'));

describe('the context manifest', () => {
  it('passes a payload that carries every included item whole', () => {
    const m = new ManifestBuilder();
    const text = [m.include('page', 'Runbook', 'x'.repeat(500)), m.include('file', 'notes.txt', 'y'.repeat(300))].join(
      '\n',
    );
    expect(checkPayload(m.build(), `INSTRUCTIONS\n${text}\nQUESTION`)).toEqual([]);
  });

  it('finds an item that is missing, or that arrived cut short', () => {
    const m = new ManifestBuilder();
    const page = m.include('page', 'Runbook', 'x'.repeat(2000));
    m.include('page', 'Gateway', 'z'.repeat(100));
    expect(checkPayload(m.build(), page.slice(0, 600))).toEqual([
      'Runbook arrived with 595 of its 2000 characters',
      'Gateway is missing',
    ]);
  });

  it('counts what was sent and names what was left out, except an excluded page', () => {
    const m = new ManifestBuilder();
    m.include('section', 'Runbook › Rollback', 'abc');
    m.include('file', 'big.log', 'def', true);
    m.includeTurns(4, 120);
    m.leaveOut('page', 'Salary Bands', 0, 'excluded');
    m.leaveOut('page', 'Deploy Notes', 0, 'secret');
    m.leaveOut('turn', '2 earlier messages', 900, 'history-limit');
    expect(summarise(m.build())).toEqual({
      pages: 0,
      sections: 1,
      files: 1,
      turns: 4,
      chars: 126,
      leftOut: [
        { kind: 'page', label: '', reason: 'excluded' },
        { kind: 'page', label: 'Deploy Notes', reason: 'secret' },
        { kind: 'turn', label: '2 earlier messages', reason: 'history-limit' },
        { kind: 'file', label: 'big.log', reason: 'cut' },
      ],
    });
  });
});

describe('the engine', () => {
  it('refuses, and raises a problem, rather than send a request missing context it was built to carry', async () => {
    const dataDir = tmp();
    const sent: GuardedPayload[] = [];
    const problems: string[] = [];
    const ai = new ConfiguredAi(new AiSettingsStore(dataDir, {}), {
      dataDir,
      env: {},
      log: () => undefined,
      transport: (payload) => {
        sent.push(payload);
        return Promise.resolve('answer');
      },
      tracer: { ...noTracer, problem: (_kind, message) => void problems.push(message) },
    });
    const m = new ManifestBuilder();
    const block = m.include('page', 'Runbook', 'steps '.repeat(200));
    const guard = new OutboundGuard();
    await expect(
      ai.chat({ context: block.slice(0, 100), history: [], prompt: 'q', manifest: m.build() }, { guard }),
    ).rejects.toBeInstanceOf(ContextCheckError);
    expect(sent).toEqual([]);
    expect(problems[0]).toMatch(/^A request was refused because it was missing context: Runbook arrived with/);
    const answer = await ai.chat({ context: block, history: [], prompt: 'q', manifest: m.build() }, { guard });
    expect(answer.text).toBe('answer');
  });

  it('reports an answer the model did not finish', async () => {
    const dataDir = tmp();
    const ai = new ConfiguredAi(new AiSettingsStore(dataDir, {}), {
      dataDir,
      env: {},
      log: () => undefined,
      transport: () => Promise.resolve({ text: 'The first half', cutOff: 'length' as const }),
    });
    expect(await ai.analyzeDocument('doc', 'q')).toMatchObject({ text: 'The first half', cutOff: 'length' });
  });
});

/* eslint-disable camelcase -- the field names are each provider's own */
describe('each provider', () => {
  it('says when an answer was cut at the output limit or blocked', () => {
    expect(cutOffOf('anthropic', { stop_reason: 'max_tokens' })).toBe('length');
    expect(cutOffOf('anthropic', { stop_reason: 'end_turn' })).toBeUndefined();
    expect(cutOffOf('openai', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })).toBe(
      'length',
    );
    expect(cutOffOf('openai', { status: 'incomplete', incomplete_details: { reason: 'content_filter' } })).toBe(
      'blocked',
    );
    expect(cutOffOf('openai', { status: 'completed' })).toBeUndefined();
    expect(cutOffOf('gemini', { candidates: [{ finishReason: 'MAX_TOKENS' }] })).toBe('length');
    expect(cutOffOf('gemini', { candidates: [{ finishReason: 'SAFETY' }] })).toBe('blocked');
    expect(cutOffOf('gemini', { promptFeedback: { blockReason: 'OTHER' } })).toBe('blocked');
    expect(cutOffOf('gemini', { candidates: [{ finishReason: 'STOP' }] })).toBeUndefined();
  });
});
/* eslint-enable camelcase */

describe('the Gemini CLI', () => {
  /** A stand-in for the CLI: it reports how many bytes reached it, then writes `tail` and exits with `code`. */
  const standIn = (tail: string, code = 0): string => {
    const file = path.join(tmp(), 'cli.mjs');
    fs.writeFileSync(
      file,
      `let n = 0;
process.stdin.on('data', (c) => (n += c.length));
process.stdin.on('end', async () => {
  process.stdout.write('bytes:' + n + ' ');
  const tail = Buffer.from(${JSON.stringify(tail)});
  // Written a byte at a time, so a character spans two chunks of output.
  for (const b of tail) { process.stdout.write(Buffer.from([b])); await new Promise((r) => setTimeout(r, 1)); }
  process.exit(${code});
});`,
    );
    return file;
  };
  const payload = (document: string): GuardedPayload =>
    new OutboundGuard().inspect({ system: 'SYSTEM {{PROMPT}}', prompt: 'q', document }).payload;

  it('receives every byte of a large payload, and its answer arrives with every character whole', async () => {
    const document = `Überprüfung — ${'données é '.repeat(40_000)}`;
    const sent = payload(document);
    const expected = Buffer.byteLength(`INSTRUCTIONS:\n${sent.system}\n\nDOCUMENT:\n${sent.messages[0].content}`);
    const reply = await runGeminiCli(standIn('Réponse prête ✓'), sent, process.env);
    expect(reply).toEqual({ text: `bytes:${expected} Réponse prête ✓` });
  });

  it('reports no answer as an error, and an answer followed by a failure as cut short', async () => {
    await expect(runGeminiCli(standIn('', 0), payload('doc'), process.env)).resolves.toMatchObject({
      text: expect.stringMatching(/^bytes:\d+$/) as string,
    });
    const empty = path.join(tmp(), 'empty.mjs');
    fs.writeFileSync(empty, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));");
    await expect(runGeminiCli(empty, payload('doc'), process.env)).rejects.toThrow('the Gemini CLI gave no answer');
    expect(await runGeminiCli(standIn('partial', 1), payload('doc'), process.env)).toMatchObject({ cutOff: 'length' });
  });
});

let fake: FakeConfluence;
beforeAll(async () => {
  fake = await startFakeConfluence();
});
afterAll(async () => {
  await fake.close();
});

/** Every marked item an answer says it sent is in the payload that went out, and the counts agree. */
function checkSent(app: TestApp, before: number, turn: SessionTurn): void {
  const payloads = app.sent.slice(before).filter((p) => !p.system.includes('choosing which sections'));
  const text = payloads
    .at(-1)!
    .messages.map((m) => m.content)
    .join('\n');
  const markers = text.match(/⟦c\d+⟧/g) ?? [];
  const sent = turn.sent!;
  expect(markers).toHaveLength(sent.pages + sent.sections + sent.files);
  // What was sent agrees with what the answer says it read, so neither can be empty while the other is not.
  const read = (turn.matchedPages ?? []).reduce((n, p) => n + (p.sections?.length ?? 0), 0);
  if (turn.corpus?.mode === 'retrieved') expect(sent.sections).toBe(read);
  else expect(sent.pages).toBe(turn.matchedPages?.length);
  expect(markers.length).toBeGreaterThan(0);
  for (const excluded of expectations.PEOPLE.excluded) expect(JSON.stringify(sent)).not.toContain(excluded);
}

async function sync(app: TestApp, key: string): Promise<void> {
  const { body } = await app.call<{ jobId: string }>('POST', '/space-cache/sync', { spaceKey: key });
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling waits for each answer before asking again
    const { body: p } = await app.call<{ status: string }>('GET', `/space-cache/sync/status/${body.jobId}`);
    if (p.status !== 'running' && p.status !== 'pending') return;
  }
}

describe('every chat route', () => {
  it('sends what each answer says it sent, names what it left out, and never names an excluded page', async () => {
    for (const contextChars of [undefined, 300]) {
      // eslint-disable-next-line no-await-in-loop -- read in full first, then retrieved
      const app = await startTestApp(fake, undefined, {}, { contextChars });
      try {
        /* eslint-disable no-await-in-loop -- each route in turn */
        await sync(app, 'PEOPLE');
        const id = (title: string): string => fake.page('PEOPLE', title).id;
        const scopes = [
          { kind: 'page', spaceKey: 'PEOPLE', pageId: id('Travel Policy') },
          { kind: 'branch', spaceKey: 'PEOPLE', pageId: id('Interviews') },
          { kind: 'pages', spaceKey: 'PEOPLE', dirs: [id('Policies')], pageIds: [id('Benefits Overview')] },
          { kind: 'space', spaceKey: 'PEOPLE' },
        ];
        for (const scope of scopes) {
          const { body: c } = await app.call<AiSessionView>('POST', '/ai/sessions', { scope });
          const before = app.sent.length;
          const { body: answered } = await app.call<AiSessionView>('POST', `/ai/sessions/${c.id}/messages`, {
            prompt: 'Which flights can be booked in economy?',
          });
          const turn = answered.turns.at(-1)!;
          expect(turn.sent, `${scope.kind} ${contextChars}`).toBeDefined();
          checkSent(app, before, turn);
        }
        /* eslint-enable no-await-in-loop */
      } finally {
        // eslint-disable-next-line no-await-in-loop -- as above
        await app.close();
      }
    }
  });

  it('says when the start of a long conversation was not sent', async () => {
    const app = await startTestApp(fake);
    try {
      const { body: c } = await app.call<AiSessionView>('POST', '/ai/sessions', {
        scope: { kind: 'page', spaceKey: 'OPS', pageId: fake.page('OPS', 'On-Call Handbook').id },
      });
      const long = 'Please consider this detail. '.repeat(5200);
      await app.call('POST', `/ai/sessions/${c.id}/messages`, { prompt: long });
      await app.call('POST', `/ai/sessions/${c.id}/messages`, { prompt: long });
      const { body } = await app.call<AiSessionView>('POST', `/ai/sessions/${c.id}/messages`, { prompt: 'And now?' });
      expect(body.turns.at(-1)!.sent!.leftOut).toEqual([
        { kind: 'turn', label: '2 earlier messages', reason: 'history-limit' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('says when an answer was cut short', async () => {
    const app = await startTestApp(fake, () => ({ text: 'Half an answer', cutOff: 'length' }) as never);
    try {
      const { body: c } = await app.call<AiSessionView>('POST', '/ai/sessions', {
        scope: { kind: 'page', spaceKey: 'OPS', pageId: fake.page('OPS', 'On-Call Handbook').id },
      });
      const { body } = await app.call<AiSessionView>('POST', `/ai/sessions/${c.id}/messages`, { prompt: 'Summarise' });
      expect(body.turns.at(-1)).toMatchObject({ cutOff: 'length', text: 'Half an answer' });
      expect(body.turns.at(-1)!.guardSummary).toContain('The answer was cut short');
    } finally {
      await app.close();
    }
  });
});
