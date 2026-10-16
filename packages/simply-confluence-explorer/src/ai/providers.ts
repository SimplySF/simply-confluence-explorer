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

// The only module that talks to the AI providers' APIs, so the question "where do pages go?" is
// answered by reading one file (ADR-017). Every call here sends Confluence content to a third party.
// `complete` accepts only a GuardedPayload (ADR-022), and its callers have already applied the
// space's .confluenceignore.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import type { GuardedPayload } from './guard.js';
import type { ApiProvider, ResolvedApi } from './settings.js';

// Models before the current generation reject output_config.effort.
const NO_EFFORT = /^claude-(3|haiku-4|sonnet-4-5|opus-4-[015]|opus-4-1)/;

type Messages = GuardedPayload['messages'];

/**
 * The Claude request, built separately so its shape can be tested without a network.
 *
 * @param cfg The provider settings.
 * @param system The system prompt.
 * @param messages The guarded conversation.
 */
/* eslint-disable camelcase -- the field names are the Claude API's own */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the SDK's own parameter type is inferred here
export function anthropicRequest(cfg: ResolvedApi, system: string, messages: Messages) {
  return {
    model: cfg.model,
    max_tokens: 64000,
    system,
    // In a conversation the first message carries the page and file context, which is the same on
    // every turn, so it is marked for prompt caching.
    messages: messages.map((m, i) =>
      i === 0 && messages.length > 1
        ? {
            role: m.role,
            content: [{ type: 'text' as const, text: m.content, cache_control: { type: 'ephemeral' as const } }],
          }
        : { role: m.role, content: m.content },
    ),
    ...(NO_EFFORT.test(cfg.model) ? {} : { output_config: { effort: 'high' as const } }),
    // When Claude declines a request for policy reasons, Anthropic retries it on a fallback model. A
    // company gateway may not pass the beta through, so it is only requested from Anthropic directly.
    ...(cfg.baseUrl ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
  };
}
/* eslint-enable camelcase */

async function anthropic(cfg: ResolvedApi, system: string, messages: Messages): Promise<string> {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined });
  // Streamed, because page context can be long, and a long request that is not streamed can time out.
  const message = await client.beta.messages.stream(anthropicRequest(cfg, system, messages)).finalMessage();
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    throw new Error(`Claude declined this request${category ? ` (${category})` : ''}`);
  }
  return message.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}

async function openai(cfg: ResolvedApi, system: string, messages: Messages): Promise<string> {
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined });
  const input =
    messages.length === 1 ? messages[0].content : messages.map((m) => ({ role: m.role, content: m.content }));
  const response = await client.responses.create({ model: cfg.model, instructions: system, input });
  return response.output_text.trim();
}

function geminiClient(cfg: ResolvedApi): GoogleGenAI {
  return new GoogleGenAI({ apiKey: cfg.apiKey, httpOptions: cfg.baseUrl ? { baseUrl: cfg.baseUrl } : undefined });
}

async function gemini(cfg: ResolvedApi, system: string, messages: Messages): Promise<string> {
  const contents =
    messages.length === 1
      ? messages[0].content
      : messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const response = await geminiClient(cfg).models.generateContent({
    model: cfg.model,
    contents,
    config: { systemInstruction: system },
  });
  return (response.text ?? '').trim();
}

/** Sends a payload the outbound guard has passed; nothing else can be sent. */
export async function complete(provider: ApiProvider, cfg: ResolvedApi, payload: GuardedPayload): Promise<string> {
  if (!cfg.apiKey) throw new Error(`no API key is set for ${provider}`);
  if (!cfg.model) throw new Error(`no model is chosen for ${provider}`);
  const run = { anthropic, openai, gemini }[provider];
  return run(cfg, payload.system, payload.messages);
}

/**
 * The models this key can use, for the Settings dialog.
 *
 * @param provider The provider to ask.
 * @param cfg Its settings, including the key.
 */
export async function listModels(provider: ApiProvider, cfg: ResolvedApi): Promise<string[]> {
  if (!cfg.apiKey) throw new Error(`no API key is set for ${provider}`);
  const ids: string[] = [];
  if (provider === 'anthropic') {
    for await (const m of new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined }).models.list())
      ids.push(m.id);
  } else if (provider === 'openai') {
    for await (const m of new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined }).models.list())
      ids.push(m.id);
  } else {
    for await (const m of await geminiClient(cfg).models.list()) {
      if (m.name && m.supportedActions?.includes('generateContent')) ids.push(m.name.replace(/^models\//, ''));
    }
  }
  return ids.sort();
}
