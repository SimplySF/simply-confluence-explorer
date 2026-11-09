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

// A structured reply is validated, repaired once with the reason, and a fallback after that is named
// where a person can see it (ADR-079, design doc 0017).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfiguredAi, type AiEngine } from '../src/ai/engine.js';
import type { GuardedPayload } from '../src/ai/guard.js';
import { ManifestBuilder, summarise } from '../src/ai/manifest.js';
import type { JsonReply } from '../src/ai/providers.js';
import { AiSettingsStore } from '../src/ai/settings.js';
import { askStructured, chosenByNumber, jsonIn, structuredPrompt } from '../src/ai/structured.js';
import { parseChoice } from '../src/spaces/contextRetriever.js';
import { packLimit, PACK_CHARS, SMALL_PACK_CHARS } from '../src/spaces/indexPacks.js';
import { noTracer, type Tracer } from '../src/telemetry/tracer.js';

/** An AI that answers with each reply in turn and records the prompts it was sent. */
function scripted(...replies: string[]): { ai: Pick<AiEngine, 'analyzeDocument'>; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    ai: {
      analyzeDocument: (_markdown, prompt) => {
        prompts.push(prompt);
        return Promise.resolve({ text: replies[prompts.length - 1] ?? '', guard: {} as never });
      },
    },
  };
}

/** A tracer that keeps what it is told. */
function recording(): { tracer: Tracer; counts: string[]; logs: Array<{ message: string; attrs?: object }> } {
  const counts: string[] = [];
  const logs: Array<{ message: string; attrs?: object }> = [];
  return {
    counts,
    logs,
    tracer: {
      ...noTracer,
      count: (m) => counts.push(m),
      log: (_l, _k, message, attrs) => logs.push({ message, attrs }),
    },
  };
}

const prompt = { task: 'Pick a colour.', rules: ['"colour" is one of red or blue.'], example: '{"colour":"red"}' };
const validate = (json: unknown): { colour: string } | string => {
  const colour = (json as { colour?: unknown } | null)?.colour;
  return colour === 'red' || colour === 'blue' ? { colour } : 'its "colour" was not red or blue';
};

describe('a structured request', () => {
  it('is written as a task, numbered rules and an example of the exact reply', () => {
    expect(structuredPrompt(prompt)).toBe(
      'Pick a colour.\n\nRules:\n1. Reply with one JSON object only: no Markdown fence, and no words before or after it.\n' +
        '2. "colour" is one of red or blue.\n\nAn example of a reply in exactly this shape:\n{"colour":"red"}',
    );
  });

  it('takes a valid reply as it is, in one request', async () => {
    const { ai, prompts } = scripted('```json\n{"colour":"blue"}\n```');
    const result = await askStructured({ ai, input: 'x', prompt, validate, label: 'Colour' });
    expect(result).toEqual({ ok: true, value: { colour: 'blue' }, repaired: false });
    expect(prompts).toHaveLength(1);
  });

  it('asks once more for an invalid reply, quoting why it could not be used', async () => {
    const { ai, prompts } = scripted('{"colour":"green"}', '{"colour":"red"}');
    const result = await askStructured({ ai, input: 'x', prompt, validate, label: 'Colour' });
    expect(result).toEqual({ ok: true, value: { colour: 'red' }, repaired: true });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(structuredPrompt(prompt));
    expect(prompts[1]).toContain('Your last reply could not be used: its "colour" was not red or blue.');
  });

  it('gives up after two invalid replies, and names the fallback in the manifest and the log', async () => {
    const { ai, prompts } = scripted('I like the secret word swordfish.', '{"colour":"green"}');
    const manifest = new ManifestBuilder();
    const { tracer, counts, logs } = recording();
    const result = await askStructured({
      ai,
      input: 'x',
      prompt,
      validate,
      label: 'Choosing a colour',
      instead: 'red was used',
      manifest,
      tracer,
    });
    expect(result).toEqual({
      ok: false,
      reason: `the AI's reply was not what was asked for, twice (its "colour" was not red or blue)`,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Your last reply could not be used: the reply held no JSON object.');
    expect(summarise(manifest.build()).leftOut).toEqual([
      {
        kind: 'choice',
        label: 'Choosing a colour',
        reason: 'fallback',
        why: `the AI's reply was not what was asked for, twice (its "colour" was not red or blue), so red was used`,
      },
    ]);
    expect(counts).toEqual(['ai.fallbacks']);
    expect(logs[0].message).toMatch(/could not be used after one repair: Choosing a colour/);
    expect(JSON.stringify(logs)).not.toMatch(/swordfish|green/);
  });

  it('never quotes the reply in why it was not JSON, as the reason reaches the log', () => {
    expect(jsonIn('{"colour": swordfish}')).toEqual({ error: 'the reply was not valid JSON' });
    expect(jsonIn('no braces here')).toEqual({ error: 'the reply held no JSON object' });
  });
});

describe('choices by number', () => {
  const offered = ['10#0', '10#1', '20#3'];

  it('map each number back to what was offered under it', () => {
    expect(chosenByNumber([{ number: 3, why: 'steps' }, { number: '1' }], offered, 12)).toEqual([
      { item: '20#3', why: 'steps' },
      { item: '10#0' },
    ]);
  });

  it('drop a number outside the list, or one chosen twice, and keep at most the limit', () => {
    expect(
      chosenByNumber([{ number: 0 }, { number: 4 }, { number: 2 }, { number: 2 }, { number: 1.5 }], offered, 12),
    ).toEqual([{ item: '10#1' }]);
    expect(chosenByNumber([{ number: 1 }, { number: 2 }, { number: 3 }], offered, 2)).toHaveLength(2);
  });

  it('are an error when every number is outside the list, or there is no list', () => {
    expect(chosenByNumber([{ number: 9 }], offered, 12)).toBe('none of its numbers was between 1 and 3');
    expect(chosenByNumber(undefined, offered, 12)).toBe('it held no list of choices');
    expect(chosenByNumber([], offered, 12)).toEqual([]);
  });

  it('give the sections a question reads, by their ids', () => {
    expect(parseChoice({ sections: [{ number: 2, why: 'rollback' }, { number: 7 }] }, offered)).toEqual([
      { id: '10#1', why: 'rollback' },
    ]);
    expect(parseChoice({ chosen: [] }, offered)).toBe('it held no list of choices');
  });
});

describe('the engine', () => {
  const engine = (env: NodeJS.ProcessEnv, seen: Array<{ payload: GuardedPayload; json?: JsonReply }>): ConfiguredAi => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-structured-'));
    return new ConfiguredAi(new AiSettingsStore(dir, env), {
      dataDir: dir,
      env,
      log: () => undefined,
      findCli: () => '/bin/gemini',
      transport: (payload, _signal, _onText, json) => {
        seen.push({ payload, json });
        return Promise.resolve('{"colour":"red"}');
      },
    });
  };

  it('sends a structured request through the guard, asking for JSON with its schema', async () => {
    const seen: Array<{ payload: GuardedPayload; json?: JsonReply }> = [];
    const schema = { type: 'object' };
    const ai = engine({ ANTHROPIC_API_KEY: 'k', AI_PROVIDER: 'anthropic' }, seen);
    const result = await askStructured({
      ai,
      input: 'Mail ana@example.com',
      prompt,
      validate,
      label: 'Colour',
      schema,
    });
    expect(result.ok).toBe(true);
    expect(seen[0].json).toEqual({ schema });
    expect(seen[0].payload.system).toMatch(/one JSON object and nothing else\. Request: Pick a colour\./);
    expect(seen[0].payload.system).not.toMatch(/response in Markdown/);
    expect(seen[0].payload.messages[0].content).not.toContain('ana@example.com');
  });

  it('gives the Gemini CLI smaller packs of pages to index than an API provider', () => {
    expect(packLimit(engine({}, []))).toBe(SMALL_PACK_CHARS);
    expect(packLimit(engine({ ANTHROPIC_API_KEY: 'k', AI_PROVIDER: 'anthropic' }, []))).toBe(PACK_CHARS);
  });
});
