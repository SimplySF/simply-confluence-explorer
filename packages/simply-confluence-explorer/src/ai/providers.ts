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
// `complete` and `embed` accept only a GuardedPayload (ADR-022), and their callers have already
// applied the space's .confluenceignore.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { imageLabel, type GuardedImage, type GuardedPayload } from './guard.js';
import type { Reply } from './reply.js';
import type { ApiProvider, ResolvedApi } from './settings.js';

// Models before the current generation reject output_config.effort.
const NO_EFFORT = /^claude-(3|haiku-4|sonnet-4-5|opus-4-[015]|opus-4-1)/;

type Messages = GuardedPayload['messages'];

/**
 * Whether a provider's response says the answer is unfinished: cut at the output limit, or blocked.
 * Kept apart from the calls so each provider's signals can be tested without a network.
 */
export function cutOffOf(provider: ApiProvider, response: unknown): Reply['cutOff'] {
  const r = response as {
    stop_reason?: string;
    status?: string;
    incomplete_details?: { reason?: string } | null;
    candidates?: Array<{ finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  };
  if (provider === 'anthropic') return r.stop_reason === 'max_tokens' ? 'length' : undefined;
  if (provider === 'openai') {
    if (r.status !== 'incomplete') return undefined;
    return r.incomplete_details?.reason === 'content_filter' ? 'blocked' : 'length';
  }
  const finish = r.candidates?.[0]?.finishReason;
  if (
    r.promptFeedback?.blockReason ||
    ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION', 'SPII'].includes(finish ?? '')
  )
    return 'blocked';
  return finish === 'MAX_TOKENS' ? 'length' : undefined;
}

/**
 * The Claude request, built separately so its shape can be tested without a network.
 *
 * @param cfg The provider settings.
 * @param system The system prompt.
 * @param messages The guarded conversation.
 * @param images Images the space chose to send, which go with the first message (ADR-066).
 */
/* eslint-disable camelcase -- the field names are the Claude API's own */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the SDK's own parameter type is inferred here
export function anthropicRequest(cfg: ResolvedApi, system: string, messages: Messages, images: Images = []) {
  const pictures = images.flatMap((im, i) => [
    { type: 'text' as const, text: imageLabel(i, im) },
    {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: im.mediaType as ImageType, data: im.data },
    },
  ]);
  return {
    model: cfg.model,
    max_tokens: 64000,
    system,
    // In a conversation the first message carries the page and file context, which is the same on
    // every turn, so it is marked for prompt caching, with any images ahead of it.
    messages: messages.map((m, i) =>
      i === 0 && (messages.length > 1 || pictures.length > 0)
        ? {
            role: m.role,
            content: [
              ...pictures,
              {
                type: 'text' as const,
                text: m.content,
                ...(messages.length > 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
              },
            ],
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

const withCutOff = (text: string, cutOff: Reply['cutOff']): Reply => (cutOff ? { text, cutOff } : { text });

type Images = readonly GuardedImage[];
type ImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

async function anthropic(
  cfg: ResolvedApi,
  system: string,
  messages: Messages,
  images: Images,
  signal?: AbortSignal,
  onText?: (text: string) => void,
): Promise<Reply> {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined });
  // Streamed, because page context can be long, and a long request that is not streamed can time out;
  // the text so far is passed on as it arrives.
  const stream = client.beta.messages.stream(anthropicRequest(cfg, system, messages, images), { signal });
  if (onText) stream.on('text', (_delta: string, snapshot: string) => onText(snapshot));
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    throw new Error(`Claude declined this request${category ? ` (${category})` : ''}`);
  }
  const text = message.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  return withCutOff(text, cutOffOf('anthropic', message));
}

async function openai(
  cfg: ResolvedApi,
  system: string,
  messages: Messages,
  images: Images,
  signal?: AbortSignal,
): Promise<Reply> {
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined });
  const pictures = images.flatMap((im, i) => [
    { type: 'input_text' as const, text: imageLabel(i, im) },
    {
      type: 'input_image' as const,
      // eslint-disable-next-line camelcase -- the OpenAI API's own field name
      image_url: `data:${im.mediaType};base64,${im.data}`,
      detail: 'auto' as const,
    },
  ]);
  const input =
    messages.length === 1 && pictures.length === 0
      ? messages[0].content
      : messages.map((m, i) =>
          i === 0 && pictures.length > 0
            ? { role: 'user' as const, content: [{ type: 'input_text' as const, text: m.content }, ...pictures] }
            : { role: m.role, content: m.content },
        );
  const response = await client.responses.create({ model: cfg.model, instructions: system, input }, { signal });
  return withCutOff(response.output_text.trim(), cutOffOf('openai', response));
}

function geminiClient(cfg: ResolvedApi): GoogleGenAI {
  return new GoogleGenAI({ apiKey: cfg.apiKey, httpOptions: cfg.baseUrl ? { baseUrl: cfg.baseUrl } : undefined });
}

async function gemini(
  cfg: ResolvedApi,
  system: string,
  messages: Messages,
  images: Images,
  signal?: AbortSignal,
): Promise<Reply> {
  const pictures = images.flatMap((im, i) => [
    { text: imageLabel(i, im) },
    { inlineData: { mimeType: im.mediaType, data: im.data } },
  ]);
  const contents =
    messages.length === 1 && pictures.length === 0
      ? messages[0].content
      : messages.map((m, i) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }, ...(i === 0 ? pictures : [])],
        }));
  const response = await geminiClient(cfg).models.generateContent({
    model: cfg.model,
    contents,
    config: { systemInstruction: system, abortSignal: signal },
  });
  return withCutOff((response.text ?? '').trim(), cutOffOf('gemini', response));
}

/**
 * Sends a payload the outbound guard has passed; nothing else can be sent. Aborting `signal` ends the
 * request, though a provider may already have received it.
 */
export async function complete(
  provider: ApiProvider,
  cfg: ResolvedApi,
  payload: GuardedPayload,
  signal?: AbortSignal,
  onText?: (text: string) => void,
): Promise<Reply> {
  if (!cfg.apiKey) throw new Error(`no API key is set for ${provider}`);
  if (!cfg.model) throw new Error(`no model is chosen for ${provider}`);
  const images = payload.images ?? [];
  if (provider === 'anthropic') return anthropic(cfg, payload.system, payload.messages, images, signal, onText);
  const run = { openai, gemini }[provider];
  return run(cfg, payload.system, payload.messages, images, signal);
}

/**
 * The embedding model each provider offers (ADR-051). Claude has none, so a space searched with Claude
 * is searched by its words and metadata alone.
 */
export const EMBEDDING_MODELS: Partial<Record<ApiProvider, string>> = {
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-001',
};

/** The length of every vector, small enough that a large space's vectors fit in memory. */
export const EMBEDDING_DIMENSIONS = 512;

/**
 * Embeds each message of a payload the outbound guard has passed, returning one vector per message.
 *
 * @param provider A provider in `EMBEDDING_MODELS`.
 * @param cfg Its settings, including the key.
 * @param payload The guarded texts, one per message.
 * @param signal Ends the request when the person stops it.
 */
export async function embed(
  provider: ApiProvider,
  cfg: ResolvedApi,
  payload: GuardedPayload,
  signal?: AbortSignal,
): Promise<number[][]> {
  const model = EMBEDDING_MODELS[provider];
  if (!model) throw new Error(`${provider} offers no embeddings`);
  if (!cfg.apiKey) throw new Error(`no API key is set for ${provider}`);
  const input = payload.messages.map((m) => m.content);
  if (input.length === 0) return [];
  if (provider === 'openai') {
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl || undefined });
    const response = await client.embeddings.create({ model, input, dimensions: EMBEDDING_DIMENSIONS }, { signal });
    return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  const response = await geminiClient(cfg).models.embedContent({
    model,
    contents: input,
    config: { outputDimensionality: EMBEDDING_DIMENSIONS, abortSignal: signal },
  });
  return (response.embeddings ?? []).map((e) => e.values ?? []);
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
