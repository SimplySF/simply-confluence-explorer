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

// The AI layer: settings never leak a key, the Gemini CLI is found where real installs put it, and
// each provider's request is what that provider expects. Providers are exercised against a local
// stand-in through the base-URL setting, so nothing here needs a network or a real key.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { ConfiguredAi } from '../src/ai/engine.js';
import { resolveGeminiCli, runGeminiCli, systemCliLookup, type CliLookup } from '../src/ai/geminiService.js';
import { OutboundGuard } from '../src/ai/guard.js';
import { anthropicRequest, complete } from '../src/ai/providers.js';
import { AiSettingsStore, type Provider } from '../src/ai/settings.js';
import { createServer } from '../src/server.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-ai-'));
const store = (env: NodeJS.ProcessEnv = {}, dir = tmp()): AiSettingsStore => new AiSettingsStore(dir, env);
const engine = (settings: AiSettingsStore, cli: string | null = null): ConfiguredAi =>
  new ConfiguredAi(settings, { dataDir: tmp(), env: {}, log: () => {}, findCli: () => cli });

test('a saved key is stored owner-only and never appears in what a browser sees', () => {
  const dir = tmp();
  const s = store({}, dir);
  s.update({ provider: 'anthropic', anthropic: { apiKey: 'sk-secret-123' } });
  const file = path.join(dir, 'config', 'ai-settings.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const view = JSON.stringify(s.publicView());
  assert.doesNotMatch(view, /sk-secret-123/);
  assert.equal(s.publicView().providers.anthropic.keySet, true);
  assert.equal(s.publicView().providers.anthropic.keySource, 'settings');
});

test('an omitted key is kept, an empty key is removed', () => {
  const s = store();
  s.update({ openai: { apiKey: 'k1', model: 'm1' } });
  s.update({ openai: { model: 'm2' } });
  assert.equal(s.resolve().api.openai.apiKey, 'k1');
  assert.equal(s.resolve().api.openai.model, 'm2');
  s.update({ openai: { apiKey: '' } });
  assert.equal(s.resolve().api.openai.apiKey, '');
});

test('keys and the provider fall back to the environment, and settings win over it', () => {
  const s = store({ GEMINI_API_KEY: 'from-env', AI_PROVIDER: 'gemini' });
  assert.equal(s.resolve().provider, 'gemini');
  assert.equal(s.publicView().providers.gemini.keySource, 'env');
  s.update({ provider: 'anthropic' });
  assert.equal(s.resolve().provider, 'anthropic');
});

test('defaults: Claude Opus 5.5 and the Gemini Pro alias; ChatGPT has none and must be chosen', () => {
  const r = store().resolve();
  assert.equal(r.provider, 'gemini-cli');
  assert.equal(r.api.anthropic.model, 'claude-opus-5-5');
  assert.equal(r.api.gemini.model, 'gemini-pro-latest');
  assert.equal(r.api.openai.model, '');
});

test('an unknown provider and a non-http base URL are refused', () => {
  const s = store();
  assert.throws(() => s.update({ provider: 'llama' as Provider }), /unknown AI provider/);
  assert.throws(() => s.update({ openai: { baseUrl: 'file:///etc/passwd' } }), /http/);
});

// The Gemini CLI is found where real installs put it.

function fakeInstall(files: string[]): string {
  const root = tmp();
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), '');
  }
  return root;
}
const BUNDLE = 'node_modules/@google/gemini-cli/bundle/gemini.js';
const lookup = (over: Partial<CliLookup>): CliLookup => ({
  ...systemCliLookup('', {}),
  env: {},
  execPath: '/nowhere/node',
  ...over,
});

test('Windows: the npm global prefix on PATH, beside gemini.cmd', () => {
  const root = fakeInstall(['npm/gemini.cmd', `npm/${BUNDLE}`]);
  const found = resolveGeminiCli(lookup({ platform: 'win32', env: { PATH: `C:\\Windows;${path.join(root, 'npm')}` } }));
  assert.equal(found, path.join(root, 'npm', BUNDLE));
});

test('Windows: a portable Node under %LOCALAPPDATA%\\Programs, whatever its version', () => {
  const root = fakeInstall([`Programs/node-v24.20.1-win-x64/${BUNDLE}`]);
  const found = resolveGeminiCli(lookup({ platform: 'win32', env: { LOCALAPPDATA: root } }));
  assert.equal(found, path.join(root, 'Programs', 'node-v24.20.1-win-x64', BUNDLE));
});

test.skipIf(process.platform === 'win32')(
  'Linux and macOS: the gemini symlink on PATH is followed to its bundle',
  () => {
    const root = fakeInstall([`lib/${BUNDLE}`]);
    fs.mkdirSync(path.join(root, 'bin'));
    fs.symlinkSync(path.join(root, 'lib', BUNDLE), path.join(root, 'bin', 'gemini'));
    const found = resolveGeminiCli(lookup({ platform: 'linux', env: { PATH: `/usr/bin:${path.join(root, 'bin')}` } }));
    assert.equal(found, fs.realpathSync(path.join(root, 'lib', BUNDLE)));
  },
);

test('a configured path wins, and a wrong one is reported as not found rather than discovered past', () => {
  const root = fakeInstall([`npm/${BUNDLE}`, `other/${BUNDLE}`]);
  const env = { PATH: path.join(root, 'npm') };
  assert.equal(
    resolveGeminiCli(lookup({ platform: 'linux', env, configured: path.join(root, 'other', BUNDLE) })),
    path.join(root, 'other', BUNDLE),
  );
  assert.equal(resolveGeminiCli(lookup({ platform: 'linux', env, configured: path.join(root, 'missing.js') })), null);
  assert.equal(resolveGeminiCli(lookup({ platform: 'linux', env: {} })), null);
});

// Each provider receives the request it expects. The stand-in replies use each API's own field names.
/* eslint-disable camelcase */

type Seen = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };

async function standIn(
  reply: (req: Seen, res: http.ServerResponse) => void,
): Promise<{ seen: Seen[]; url: string; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const s = {
        path: req.url ?? '',
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      seen.push(s);
      reply(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

// What the guard hands a provider for a plain system prompt and document.
const guarded = (system: string, document: string): ReturnType<OutboundGuard['inspect']>['payload'] =>
  new OutboundGuard().inspect({ system, prompt: '', document }).payload;

const cfg = (
  baseUrl: string,
  model: string,
): { apiKey: string; keySource: 'settings'; model: string; baseUrl: string } => ({
  apiKey: 'test-key',
  keySource: 'settings' as const,
  model,
  baseUrl,
});

test('Claude: streamed Messages request with the key, system prompt and model', async () => {
  const s = await standIn((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, data: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', {
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ready' } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    ev('message_stop', {});
    res.end();
  });
  try {
    assert.deepEqual(await complete('anthropic', cfg(s.url, 'claude-opus-5-5'), guarded('SYSTEM', 'DOC')), {
      text: 'ready',
    });
    const req = s.seen[0];
    assert.match(req.path, /\/v1\/messages/);
    assert.equal(req.headers['x-api-key'], 'test-key');
    assert.equal(req.body.model, 'claude-opus-5-5');
    assert.equal(req.body.system, 'SYSTEM');
    assert.equal(req.body.stream, true);
    assert.deepEqual(req.body.messages, [{ role: 'user', content: 'DOC' }]);
  } finally {
    s.close();
  }
});

test('Claude: refusal fallback is requested from Anthropic directly, never through a gateway', () => {
  const direct = anthropicRequest(cfg('', 'claude-opus-5-5'), 's', [{ role: 'user', content: 'u' }]);
  assert.equal(direct.fallbacks, 'default');
  assert.deepEqual(direct.betas, ['server-side-fallback-2026-07-01']);
  const gateway = anthropicRequest(cfg('https://gateway.example.com', 'claude-opus-5-5'), 's', [
    { role: 'user', content: 'u' },
  ]);
  assert.equal('fallbacks' in gateway, false);
  assert.equal('betas' in gateway, false);
});

test('ChatGPT: Responses API with the key as a bearer token and the system prompt as instructions', async () => {
  const s = await standIn((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'resp_1',
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: 'm',
        output: [
          {
            type: 'message',
            id: 'msg_1',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ready', annotations: [] }],
          },
        ],
      }),
    );
  });
  try {
    assert.deepEqual(await complete('openai', cfg(`${s.url}/v1`, 'chosen-model'), guarded('SYSTEM', 'DOC')), {
      text: 'ready',
    });
    const req = s.seen[0];
    assert.equal(req.path, '/v1/responses');
    assert.equal(req.headers.authorization, 'Bearer test-key');
    assert.equal(req.body.model, 'chosen-model');
    assert.equal(req.body.instructions, 'SYSTEM');
    assert.equal(req.body.input, 'DOC');
  } finally {
    s.close();
  }
});

test('Gemini API: generateContent with the key header and the system prompt as a system instruction', async () => {
  const s = await standIn((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ready' }] } }] }));
  });
  try {
    assert.deepEqual(await complete('gemini', cfg(s.url, 'gemini-pro-latest'), guarded('SYSTEM', 'DOC')), {
      text: 'ready',
    });
    const req = s.seen[0];
    assert.match(req.path, /models\/gemini-pro-latest:generateContent/);
    assert.equal(req.headers['x-goog-api-key'], 'test-key');
    assert.match(JSON.stringify(req.body), /SYSTEM/);
    assert.match(JSON.stringify(req.body), /DOC/);
  } finally {
    s.close();
  }
});

test('no key or no model fails before anything is sent', async () => {
  await assert.rejects(complete('anthropic', { ...cfg('', 'm'), apiKey: '' }, guarded('s', 'u')), /no API key/);
  await assert.rejects(complete('openai', cfg('', ''), guarded('s', 'u')), /no model/);
});

/* eslint-enable camelcase */

// The engine and its settings route.

test('the engine follows the chosen provider, and reports unavailable without a key', () => {
  const s = store();
  const ai = engine(s);
  assert.equal(ai.isAvailable(), false);
  assert.equal(ai.getEngine(), 'none');
  s.update({ provider: 'anthropic', anthropic: { apiKey: 'k' } });
  assert.equal(ai.isAvailable(), true);
  assert.equal(ai.getEngine(), 'Claude (claude-opus-5-5)');
  const cli = engine(store(), '/x/gemini.js');
  assert.equal(cli.getEngine(), 'Gemini CLI');
});

test('the settings API saves a key and never returns it', async () => {
  const dir = tmp();
  const server = createServer({ webRoot: dir, dataDir: dir, env: {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai/settings`;
  try {
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', openai: { apiKey: 'sk-never-shown', model: 'm' } }),
    });
    assert.equal(put.status, 200);
    const text = await (await fetch(url)).text();
    assert.doesNotMatch(text, /sk-never-shown/);
    assert.equal((JSON.parse(text) as { providers: { openai: { keySet: boolean } } }).providers.openai.keySet, true);
    const wrongType = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openai: { apiKey: 42 } }),
    });
    assert.equal(wrongType.status, 400);
    const bad = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'nope' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test('a stopped request ends the call to every provider instead of waiting for its answer', async () => {
  const closed: string[] = [];
  // A provider that never answers; it only notices when the request is dropped.
  const server = http.createServer((req) => req.on('close', () => closed.push(req.url ?? '')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [provider, model] of [
      ['anthropic', 'claude-opus-5-5'],
      ['openai', 'gpt-5'],
      ['gemini', 'gemini-3-pro'],
    ] as const) {
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 50);
      // eslint-disable-next-line no-await-in-loop -- one provider at a time, so each close is its own
      await assert.rejects(complete(provider, cfg(url, model), guarded('S', 'D'), stop.signal));
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed.length, 3);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a stopped Gemini CLI run ends the process', async () => {
  const dir = tmp();
  const script = path.join(dir, 'gemini.js');
  // A stand-in for the CLI that would run for a minute.
  fs.writeFileSync(script, 'setTimeout(() => {}, 60000);\n');
  const stop = new AbortController();
  const started = Date.now();
  setTimeout(() => stop.abort(), 100);
  await assert.rejects(runGeminiCli(script, guarded('S', 'D'), {}, stop.signal), /stopped/);
  assert.ok(Date.now() - started < 5000);
});

test('requests at once for the AI index default by provider, and stay between 1 and 8', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-parallel-'));
  const s = new AiSettingsStore(dir, {});
  assert.equal(s.resolve().parallel, 2, 'the Gemini CLI starts a program per request, so it runs fewer');
  s.update({ provider: 'anthropic' });
  assert.equal(s.resolve().parallel, 4);
  s.update({ parallel: 6 });
  assert.equal(s.resolve().parallel, 6);
  assert.equal(s.publicView().parallel, 6);
  for (const bad of [0, 9, 2.5]) assert.throws(() => s.update({ parallel: bad }), /from 1 to 8/);
});
