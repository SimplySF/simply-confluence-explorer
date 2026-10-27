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

import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../util/errors.js';
import { noTracer, type Attrs, type Tracer } from '../telemetry/tracer.js';
import { geminiCliVersion, resolveGeminiCli, runGeminiCli, systemCliLookup } from './geminiService.js';
import {
  loadGuardRules,
  OutboundGuard,
  type ChatTurn,
  type GuardedPayload,
  type GuardReport,
  type ImageInput,
} from './guard.js';
import { checkImages, checkPayload, ContextCheckError, summarise, type ContextManifest } from './manifest.js';
import { complete, embed, EMBEDDING_MODELS, listModels } from './providers.js';
import { droppedNote, type Reply } from './reply.js';
import type { AiSettingsStore, ApiProvider } from './settings.js';

// The engine is the only code that sends anything to an AI (ADR-022). Every request passes the
// outbound guard first, because `complete` and the CLI runner accept only what the guard returns,
// and every request is recorded in the audit log: what was sent, to whom, and what the guard
// removed, but never the content itself.

// Listing models sends no page content, but it goes through here so that the engine stays the only
// module that reaches the providers (ADR-022).
export { listModels };

export type AiAnswer = {
  text: string;
  guard: GuardReport;
  /** The model stopped before finishing: at its output limit, or because the answer was blocked. */
  cutOff?: Reply['cutOff'];
  /** Images the answer was made without, because the provider gave no answer with them. */
  imagesDropped?: string[];
  /** What the provider said when it gave no answer with them. */
  whyDropped?: string;
};

/** The answer a person reads: the reply with its placeholders put back, and what it says about itself. */
function answerOf(reply: Reply, guard: OutboundGuard, report: GuardReport): AiAnswer {
  return {
    text: guard.restore(reply.text),
    guard: report,
    ...(reply.cutOff ? { cutOff: reply.cutOff } : {}),
    ...(reply.imagesDropped?.length ? { imagesDropped: reply.imagesDropped } : {}),
    ...(reply.imagesDropped?.length && reply.whyDropped ? { whyDropped: reply.whyDropped } : {}),
  };
}

export type AiContext = {
  /** The space the content comes from, whose .confluenceguard rules apply. */
  spaceKey?: string;
  /** A conversation's guard, so a value keeps its placeholder from one turn to the next. */
  guard?: OutboundGuard;
  /** Aborts the request when the person stops it (ADR-047). */
  signal?: AbortSignal;
  /** Told the answer so far while it is written, where the provider streams it, so progress can be shown. */
  onText?: (text: string) => void;
  /** Images the space chose to send with the document, which the guard records as unchecked (ADR-066). */
  images?: ImageInput[];
};

/** A request the person stopped. Nothing may act on its answer, even one that arrives afterwards. */
export class AiStopped extends Error {
  // 499 is the status for a request the client gave up on; the browser that stopped it is not waiting.
  public readonly status = 499;

  public constructor() {
    super('The request to the AI was stopped.');
  }
}

/** What the routes need from an AI engine. Tests pass their own. */
export type AiEngine = {
  isAvailable: () => boolean;
  getEngine: () => string;
  analyzeDocument: (markdown: string, prompt: string, pageTitle?: string, ctx?: AiContext) => Promise<AiAnswer>;
  /** The model texts are embedded with, or null when this engine has none (ADR-051). */
  embeddingModel?: () => string | null;
  /** How many requests long-running work, such as the AI index, may send at once. */
  parallel?: () => number;
  /** One vector per text, or null for a text the guard left out because it holds a secret. */
  embed?: (texts: string[], ctx: AiContext) => Promise<Array<number[] | null>>;
  /** One turn of a conversation, with its context and earlier turns. */
  chat: (parts: ChatParts, ctx: AiContext & { guard: OutboundGuard }) => Promise<AiAnswer>;
};

/** One turn of a conversation; with a manifest, the engine checks the context arrived whole (ADR-054). */
export type ChatParts = {
  context: string;
  history: ChatTurn[];
  prompt: string;
  system?: string;
  manifest?: ContextManifest;
  /** Images the space chose to send with the context (ADR-066). */
  images?: ImageInput[];
};

/** Sends a guarded payload and returns the reply. The real one calls a provider or the CLI. */
export type Transport = (
  payload: GuardedPayload,
  signal?: AbortSignal,
  onText?: (text: string) => void,
) => Promise<string | Reply>;
/** Embeds each message of a guarded payload. The real one calls a provider. */
export type EmbedTransport = (payload: GuardedPayload, signal?: AbortSignal) => Promise<number[][]>;

/** How many texts one embedding request carries, below every provider's limit. */
const EMBED_BATCH = 50;

export const CHAT_SYSTEM =
  'You are an expert technical assistant helping a person work with their Confluence documentation. ' +
  'The pages and files they are working with come first in the conversation. Answer in Markdown, ' +
  'name the page or file an answer comes from, and say plainly when the documents do not contain the answer.';

const ANALYZE_SYSTEM =
  'You are an expert technical assistant analyzing the Confluence documentation in the message below. ' +
  'Provide a well-structured, clear, professional response in Markdown. User request: {{PROMPT}}';

const LABEL: Record<ApiProvider, string> = { anthropic: 'Claude', openai: 'ChatGPT', gemini: 'Gemini API' };

export type EngineOptions = {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
  /** Finds the Gemini CLI from a configured path. Tests pass their own. */
  findCli?: (configured: string) => string | null;
  /** Sends the payload. Tests pass their own, so nothing leaves the machine. */
  transport?: Transport;
  /** Embeds texts. Tests that pass a `transport` have embeddings only when they pass this too. */
  embedTransport?: EmbedTransport;
  /** Where each request is recorded as a span of the trace it belongs to (ADR-054). */
  tracer?: Tracer;
};

/**
 * The engine chosen in Settings. Settings are read on every call, so a change applies to the next
 * request without a restart.
 */
export class ConfiguredAi implements AiEngine {
  private readonly auditFile: string;
  private readonly findCli: (configured: string) => string | null;

  public constructor(
    public readonly settings: AiSettingsStore,
    private readonly options: EngineOptions,
  ) {
    this.auditFile = path.join(options.dataDir, 'data', 'ai-audit.jsonl');
    this.findCli =
      options.findCli ?? ((configured): string | null => resolveGeminiCli(systemCliLookup(configured, options.env)));
  }

  public cliPath(): string | null {
    return this.findCli(this.settings.resolve().geminiCliPath);
  }

  public isAvailable(): boolean {
    const s = this.settings.resolve();
    if (s.provider === 'gemini-cli') return this.cliPath() !== null;
    return !!(s.api[s.provider].apiKey && s.api[s.provider].model);
  }

  public getEngine(): string {
    const s = this.settings.resolve();
    if (s.provider === 'gemini-cli') {
      const cli = this.cliPath();
      const version = cli && geminiCliVersion(cli);
      return cli ? `Gemini CLI${version ? ` ${version}` : ''}` : 'none';
    }
    const api = s.api[s.provider];
    return api.apiKey && api.model ? `${LABEL[s.provider]} (${api.model})` : 'none';
  }

  public async analyzeDocument(
    markdown: string,
    prompt: string,
    pageTitle?: string,
    ctx: AiContext = {},
  ): Promise<AiAnswer> {
    const guard = ctx.guard ?? new OutboundGuard(loadGuardRules(this.options.dataDir, ctx.spaceKey));
    const { payload, report } = guard.inspect({
      system: ANALYZE_SYSTEM,
      prompt,
      document: `# Document Title: ${pageTitle ?? 'Confluence Document'}\n\n${markdown}\n`,
      images: ctx.images,
    });
    return this.deliver(payload, report, guard, ctx);
  }

  public async chat(parts: ChatParts, ctx: AiContext & { guard: OutboundGuard }): Promise<AiAnswer> {
    const { payload, report } = ctx.guard.inspectChat({ ...parts, system: parts.system ?? CHAT_SYSTEM });
    if (!parts.manifest) return this.deliver(payload, report, ctx.guard, ctx);
    // The context must reach the model whole: a request missing part of what it was built to carry is
    // refused, and raised as a problem, rather than sent.
    const problems = [
      ...checkPayload(
        parts.manifest,
        payload.messages.map((m) => m.content).join('\n'),
        [parts.context, ...parts.history.map((t) => t.text), parts.prompt].join('\n'),
      ),
      ...checkImages(parts.manifest, payload.images?.length ?? 0),
    ];
    const tracer = this.options.tracer ?? noTracer;
    if (problems.length > 0) {
      tracer.problem('context', `A request was refused because it was missing context: ${problems[0]}.`);
      throw new ContextCheckError(problems);
    }
    const sent = summarise(parts.manifest);
    return this.deliver(payload, report, ctx.guard, ctx, {
      pages: sent.pages,
      sections: sent.sections,
      files: sent.files,
      earlierTurns: sent.turns,
      contextChars: sent.chars,
      leftOut: sent.leftOut.map((l) => `${l.kind}${l.label ? ` "${l.label}"` : ''}: ${l.reason}`),
    });
  }

  public parallel(): number {
    return this.settings.resolve().parallel;
  }

  public embeddingModel(): string | null {
    if (this.options.transport) return this.options.embedTransport ? 'stand-in' : null;
    const provider = this.embeddingProvider();
    return provider ? (EMBEDDING_MODELS[provider] ?? null) : null;
  }

  /**
   * Embeds texts in batches, each through the outbound guard and recorded in the audit log like any
   * request. A text holding a secret is not sent and gets no vector.
   */
  public async embed(texts: string[], ctx: AiContext = {}): Promise<Array<number[] | null>> {
    const model = this.embeddingModel();
    const vectors: Array<number[] | null> = texts.map(() => null);
    if (!model) return vectors;
    const guard = new OutboundGuard(loadGuardRules(this.options.dataDir, ctx.spaceKey));
    for (let start = 0; start < texts.length; start += EMBED_BATCH) {
      const { payload, report, skipped } = guard.inspectTexts(texts.slice(start, start + EMBED_BATCH));
      const sent = texts
        .slice(start, start + EMBED_BATCH)
        .map((_, i) => i)
        .filter((i) => !skipped.includes(i));
      if (ctx.signal?.aborted) throw new AiStopped();
      const entry = {
        engine: `${this.options.transport ? this.getEngine() : (this.embeddingProvider() ?? 'no provider')} embeddings (${model})`,
        spaceKey: ctx.spaceKey ?? null,
        chars: payload.messages.reduce((n, m) => n + m.content.length, 0),
        texts: sent.length,
        withheld: skipped.length,
        redacted: report.redacted,
      };
      if (sent.length === 0) continue;
      let batch: number[][];
      try {
        // eslint-disable-next-line no-await-in-loop -- one batch at a time, as providers limit request rates
        batch = await this.traced('embed', entry, () => this.sendEmbed(payload, ctx.signal), ctx.signal);
      } catch (error) {
        this.audit({ ...entry, outcome: ctx.signal?.aborted ? 'stopped' : `failed: ${errorMessage(error)}` });
        throw ctx.signal?.aborted ? new AiStopped() : error;
      }
      this.audit({ ...entry, outcome: 'sent' });
      if (batch.length !== sent.length) throw new Error('the provider returned a different number of embeddings');
      sent.forEach((i, k) => (vectors[start + i] = batch[k]));
    }
    return vectors;
  }

  /**
   * The provider that embeds sections: the one chosen for embeddings, or the chat provider when it
   * makes them, provided its key is set. Answers still come from the chat provider, so a Gemini CLI
   * user can search by meaning with a Gemini or OpenAI key (design doc 0008).
   */
  private embeddingProvider(): ApiProvider | null {
    const s = this.settings.resolve();
    if (s.embeddings === 'none') return null;
    const provider = s.embeddings === 'chat' ? s.provider : s.embeddings;
    if (provider === 'gemini-cli' || !EMBEDDING_MODELS[provider] || !s.api[provider].apiKey) return null;
    return provider;
  }

  private sendEmbed(payload: GuardedPayload, signal?: AbortSignal): Promise<number[][]> {
    if (this.options.embedTransport) return this.options.embedTransport(payload, signal);
    const provider = this.embeddingProvider();
    if (!provider) throw new Error('no provider is set to make embeddings');
    return embed(provider, this.settings.resolve().api[provider], payload, signal);
  }

  private async send(payload: GuardedPayload, signal?: AbortSignal, onText?: (text: string) => void): Promise<Reply> {
    if (this.options.transport) {
      const reply = await this.options.transport(payload, signal, onText);
      return typeof reply === 'string' ? { text: reply } : reply;
    }
    const s = this.settings.resolve();
    if (s.provider === 'gemini-cli') {
      const cli = this.cliPath();
      if (!cli)
        throw new Error(
          'The Gemini CLI was not found. Install it, set its path in Settings, or choose an API provider.',
        );
      return runGeminiCli(cli, payload, this.options.env, signal, onText);
    }
    return complete(s.provider, s.api[s.provider], payload, signal, onText);
  }

  private async deliver(
    payload: GuardedPayload,
    report: GuardReport,
    guard: OutboundGuard,
    { spaceKey, signal, onText }: AiContext,
    manifest: Attrs = {},
  ): Promise<AiAnswer> {
    if (signal?.aborted) throw new AiStopped();
    const chars = payload.system.length + payload.messages.reduce((n, m) => n + m.content.length, 0);
    const entry = {
      engine: this.getEngine(),
      spaceKey: spaceKey ?? null,
      chars,
      turns: payload.messages.length,
      redacted: report.redacted,
      // Images are counted and sized, never recorded, and each is named as unchecked in the answer.
      ...(payload.images?.length
        ? { images: payload.images.length, imageBytes: payload.images.reduce((n, i) => n + (i.data.length * 3) / 4, 0) }
        : {}),
    };
    let reply: Reply;
    try {
      // The answer so far has its placeholders put back too, so progress shows what the person will read.
      const progress = onText && ((text: string): void => onText(guard.restore(text)));
      reply = await this.traced(
        'complete',
        { ...entry, ...manifest },
        () => this.send(payload, signal, progress),
        signal,
      );
    } catch (error) {
      // Recorded either way: a request that failed or was stopped part of the way through may still
      // have been sent.
      this.audit({ ...entry, outcome: signal?.aborted ? 'stopped' : `failed: ${errorMessage(error)}` });
      throw signal?.aborted ? new AiStopped() : error;
    }
    if (signal?.aborted) {
      this.audit({ ...entry, outcome: 'stopped' });
      throw new AiStopped();
    }
    this.audit({ ...entry, outcome: 'sent', ...(reply.cutOff ? { cutOff: reply.cutOff } : {}) });
    this.logShortfall(reply);
    return answerOf(reply, guard, report);
  }

  /** Logs an answer that is not all it was asked to be: cut short, blocked, or made without its images. */
  private logShortfall(reply: Reply): void {
    const tracer = this.options.tracer ?? noTracer;
    if (reply.cutOff)
      tracer.log(
        'warn',
        'ai',
        `An answer was ${reply.cutOff === 'blocked' ? 'blocked' : 'cut short at the output limit'}.`,
      );
    if (reply.imagesDropped?.length)
      tracer.log(
        'warn',
        'ai',
        `${this.getEngine()}: ${reply.imagesDropped.length} image(s) not read, ${droppedNote(reply.whyDropped)}.`,
      );
  }

  /** Sends as a span of the current trace, counted for the health numbers; a stopped request is not a failure. */
  private traced<T>(name: string, entry: Attrs, send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const tracer = this.options.tracer ?? noTracer;
    tracer.count('ai.requests');
    return tracer.span('ai', name, entry, async () => {
      try {
        return await send();
      } catch (error) {
        if (!signal?.aborted) tracer.count('ai.failures');
        throw signal?.aborted ? new AiStopped() : error;
      }
    });
  }

  private audit(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditFile), { recursive: true, mode: 0o700 });
      const traceId = this.options.tracer?.current()?.traceId;
      const line = { at: new Date().toISOString(), ...(traceId ? { traceId } : {}), ...entry };
      fs.appendFileSync(this.auditFile, JSON.stringify(line) + '\n', {
        mode: 0o600,
      });
    } catch (error) {
      // The audit log is a record, not a gate: a full disk must not stop the answer.
      this.options.log(`could not write the AI audit log: ${errorMessage(error)}`);
    }
  }
}
