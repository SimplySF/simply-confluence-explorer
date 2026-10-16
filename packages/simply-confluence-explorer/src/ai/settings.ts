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

import path from 'node:path';
import type { AiSettingsView } from '../api/types.js';
import { readJsonOrEmpty, writePrivateJson } from '../util/privateFile.js';

// Which AI answers, and with what credentials (ADR-017). Keys are kept in a file only the user
// running the server can read, and are never returned to a browser.

export const PROVIDERS = ['gemini-cli', 'anthropic', 'openai', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type ApiProvider = Exclude<Provider, 'gemini-cli'>;
export const API_PROVIDERS: ApiProvider[] = ['anthropic', 'openai', 'gemini'];

// OpenAI has no default, because its current model names change too often to pin; Settings lists the
// models the key can use instead.
export const DEFAULT_MODELS: Record<ApiProvider, string> = {
  anthropic: 'claude-opus-5-5',
  openai: '',
  gemini: 'gemini-pro-latest',
};

const KEY_ENV: Record<ApiProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

type ApiConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

type Stored = {
  provider?: Provider;
  anthropic?: ApiConfig;
  openai?: ApiConfig;
  gemini?: ApiConfig;
  geminiCli?: { path?: string };
};

export type ResolvedApi = {
  apiKey: string;
  keySource: 'settings' | 'env' | 'none';
  model: string;
  baseUrl: string;
};

export type Resolved = {
  provider: Provider;
  api: Record<ApiProvider, ResolvedApi>;
  geminiCliPath: string;
};

/** An update from the Settings dialog. `apiKey`: omitted keeps it, '' removes it. */
export type SettingsUpdate = {
  provider?: Provider;
  anthropic?: ApiConfig;
  openai?: ApiConfig;
  gemini?: ApiConfig;
  geminiCli?: { path?: string };
};

export class AiSettingsStore {
  private readonly file: string;

  /**
   * @param dataDir The app's data directory; settings are kept in `config/ai-settings.json`.
   * @param env The environment, read for the fallback keys, AI_PROVIDER and GEMINI_CLI_PATH.
   */
  public constructor(
    dataDir: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.file = path.join(dataDir, 'config', 'ai-settings.json');
  }

  public resolve(): Resolved {
    const stored = this.read();
    const api = {} as Record<ApiProvider, ResolvedApi>;
    for (const p of API_PROVIDERS) {
      const own = stored[p] ?? {};
      const envKey = this.env[KEY_ENV[p]] ?? '';
      api[p] = {
        apiKey: own.apiKey ?? envKey,
        keySource: own.apiKey ? 'settings' : envKey ? 'env' : 'none',
        model: own.model ?? DEFAULT_MODELS[p],
        baseUrl: own.baseUrl ?? '',
      };
    }
    const envProvider = this.env.AI_PROVIDER as Provider | undefined;
    const provider = stored.provider ?? (envProvider && PROVIDERS.includes(envProvider) ? envProvider : 'gemini-cli');
    return { provider, api, geminiCliPath: stored.geminiCli?.path ?? this.env.GEMINI_CLI_PATH ?? '' };
  }

  /** What a browser may see: everything except the keys. */
  public publicView(): Omit<AiSettingsView, 'geminiCliFound'> {
    const r = this.resolve();
    const providers = Object.fromEntries(
      API_PROVIDERS.map((p) => [
        p,
        { model: r.api[p].model, baseUrl: r.api[p].baseUrl, keySet: !!r.api[p].apiKey, keySource: r.api[p].keySource },
      ]),
    );
    return {
      provider: r.provider,
      providers: providers as AiSettingsView['providers'],
      geminiCli: { path: r.geminiCliPath },
      defaults: DEFAULT_MODELS,
    };
  }

  public update(change: SettingsUpdate): void {
    if (change.provider !== undefined && !PROVIDERS.includes(change.provider)) {
      throw new Error(`unknown AI provider: ${change.provider}`);
    }
    const next = this.read();
    if (change.provider) next.provider = change.provider;
    for (const p of API_PROVIDERS) {
      const c = change[p];
      if (!c) continue;
      if (c.baseUrl && !/^https?:\/\/[^\s/]+/.test(c.baseUrl))
        throw new Error(`${p} base URL must start with http:// or https://`);
      const cur = { ...next[p] };
      if (c.model !== undefined) cur.model = c.model.trim();
      if (c.baseUrl !== undefined) cur.baseUrl = c.baseUrl.trim().replace(/\/+$/, '');
      if (c.apiKey !== undefined) cur.apiKey = c.apiKey.trim() || undefined;
      next[p] = cur;
    }
    if (change.geminiCli?.path !== undefined) next.geminiCli = { path: change.geminiCli.path.trim() };
    writePrivateJson(this.file, next);
  }

  private read(): Stored {
    return readJsonOrEmpty<Stored>(this.file);
  }
}
