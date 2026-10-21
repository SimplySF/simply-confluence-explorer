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
import type { AiSettingsView, AnalyzeResponse, ImageChoice, MetadataProgress, PageDetail } from '../api/types.js';
import { listModels } from '../ai/engine.js';
import { guardRulesPath, parseGuardRules, withWithheld } from '../ai/guard.js';
import { API_PROVIDERS, type ApiProvider, type SettingsUpdate } from '../ai/settings.js';
import { isValidPageId } from '../http/guards.js';
import { HttpError, type Router } from '../http/router.js';
import { gatePageForAi, type GateDeps } from '../spaces/aiGate.js';
import { IMAGE_TYPES, imagesFor } from '../spaces/attachments.js';
import { collectBranch, CONTEXT_CHAR_LIMIT, leftOutNote } from '../spaces/branchContext.js';
import { corpusSize, retrieveContext } from '../spaces/contextRetriever.js';
import { corpusPages, MAX_CORPUS_IDS } from '../spaces/corpus.js';
import type { ExclusionManager } from '../spaces/exclusionManager.js';
import { generateMetadata } from '../spaces/metadata.js';
import { isImageChoice, loadSpaceSettings, saveSpaceSettings } from '../spaces/spaceSettings.js';
import type { SpaceStore } from '../spaces/spaceStore.js';
import { tagIndex } from '../spaces/tags.js';
import { errorMessage } from '../util/errors.js';
import type { Services } from './api.js';
import { fieldsOf, optionalString } from './browse.js';

/** How long the summary count waits for a space's search index before answering with its progress. */
const INDEX_WAIT_MS = 1500;

/**
 * The pages a request chooses by directory, tag and page, as a chat's chosen pages are (ADR-051), or
 * `undefined` when it chooses none. Directories and tags are resolved from the synced copy.
 */
async function chosenIdsOf(
  body: unknown,
  spaceKey: string,
  store: SpaceStore,
  exclusions: ExclusionManager,
): Promise<string[] | undefined> {
  const fields = fieldsOf(body);
  if (fields.pageIds === undefined && fields.dirs === undefined && fields.tags === undefined) return undefined;
  const list = (value: unknown): unknown[] =>
    (Array.isArray(value) ? (value as unknown[]) : []).map((v) => (typeof v === 'number' ? String(v) : v));
  const [pageIds, dirs] = [list(fields.pageIds), list(fields.dirs)];
  const tags = list(fields.tags)
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase());
  if (pageIds.length + dirs.length > MAX_CORPUS_IDS || ![...pageIds, ...dirs].every(isValidPageId))
    throw new HttpError(400, `pageIds and dirs are lists of at most ${MAX_CORPUS_IDS} page ids`);
  const scope = { kind: 'pages' as const, spaceKey, pageIds: pageIds as string[], dirs: dirs as string[], tags };
  const ids = (await corpusPages(store, exclusions, scope)).map((p) => p.id);
  if (ids.length === 0 && pageIds.length === 0) throw new HttpError(400, 'no synced pages are chosen');
  return [...new Set([...ids, ...(pageIds as string[])])];
}

/** A settings change from the browser, with every value checked to be the string it must be. */
function settingsUpdate(body: unknown): SettingsUpdate {
  const fields = fieldsOf(body);
  const text = (value: unknown, name: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error(`${name} must be a string`);
    return value;
  };
  const update: SettingsUpdate = {};
  const provider = text(fields.provider, 'provider');
  if (provider !== undefined) update.provider = provider as SettingsUpdate['provider'];
  for (const p of API_PROVIDERS) {
    if (fields[p] === undefined) continue;
    const c = fieldsOf(fields[p]);
    update[p] = {
      apiKey: text(c.apiKey, `${p}.apiKey`),
      model: text(c.model, `${p}.model`),
      baseUrl: text(c.baseUrl, `${p}.baseUrl`),
    };
  }
  const cli = text(fieldsOf(fields.geminiCli).path, 'geminiCli.path');
  if (cli !== undefined) update.geminiCli = { path: cli };
  if (fields.parallel !== undefined) {
    if (typeof fields.parallel !== 'number') throw new Error('parallel must be a number');
    update.parallel = fields.parallel;
  }
  const embeddings = text(fields.embeddings, 'embeddings');
  if (embeddings !== undefined) update.embeddings = embeddings as SettingsUpdate['embeddings'];
  return update;
}

const requiredPrompt = (body: unknown): string => {
  const prompt = optionalString(body, 'prompt')?.trim();
  if (!prompt) throw new HttpError(400, 'prompt is required');
  return prompt;
};

/**
 * Adds the routes that ask an AI about pages and spaces, and the AI settings. Every route that
 * sends a page first checks it against the space's exclusion rules (ADR-018), and every request goes
 * through the engine, where the outbound guard runs (ADR-022).
 *
 * @param router The router to add to.
 * @param services What the routes share.
 */
export function addAiRoutes(router: Router, services: Services): Router {
  const { ai, store, exclusions, metadata, dataDir, index } = services;
  const deps: GateDeps = { store, exclusions, client: services.client };
  /** How many images the pages hold, and the space's choice about them, for the coverage line. */
  const imagesOnPages = (spaceKey: string, pages: PageDetail[]): { found: number; choice: ImageChoice } => ({
    found: pages.reduce(
      (n, p) => n + p.attachments.filter((a) => IMAGE_TYPES[path.extname(a.title).toLowerCase()]).length,
      0,
    ),
    choice: loadSpaceSettings(dataDir, spaceKey).images,
  });
  const settingsView = (): AiSettingsView => ({ ...ai.settings.publicView(), geminiCliFound: ai.cliPath() });
  const gate = async (
    pageId: string,
    spaceKey?: string,
  ): Promise<{ spaceKey: string; page: NonNullable<Awaited<ReturnType<typeof gatePageForAi>>['page']> }> => {
    const result = await gatePageForAi(pageId, spaceKey, deps);
    if (!result.allowed || !result.page)
      throw new HttpError(403, result.reason ?? 'This page cannot be sent to an AI.');
    return { spaceKey: result.spaceKey, page: result.page };
  };

  return (
    router
      .add('GET', '/api/ai/settings', settingsView)
      .add('PUT', '/api/ai/settings', ({ body }) => {
        try {
          ai.settings.update(settingsUpdate(body));
        } catch (error) {
          throw new HttpError(400, errorMessage(error));
        }
        return settingsView();
      })
      .add('GET', '/api/ai/models/:provider', async ({ params }) => {
        const provider = params.provider as ApiProvider;
        if (!API_PROVIDERS.includes(provider)) throw new HttpError(400, `unknown API provider: ${provider}`);
        try {
          return { models: await listModels(provider, ai.settings.resolve().api[provider]) };
        } catch (error) {
          throw new HttpError(502, errorMessage(error));
        }
      })
      // A short prompt with no Confluence content, so trying a key sends no page anywhere.
      .add('POST', '/api/ai/test', async () => {
        try {
          const answer = await ai.analyzeDocument(
            'This is a connection test.',
            'Reply with the single word: ready',
            'Connection test',
          );
          return { ok: true, engine: ai.getEngine(), answer: answer.text.slice(0, 200) };
        } catch (error) {
          throw new HttpError(502, errorMessage(error));
        }
      })
      .add('GET', '/api/ai/status', () => ({ available: ai.isAvailable(), engine: ai.getEngine() }))
      .add('POST', '/api/ai/analyze', async ({ body }): Promise<AnalyzeResponse> => {
        const prompt = requiredPrompt(body);
        const fields = fieldsOf(body);
        const pageId = optionalString(body, 'pageId');
        let spaceKey = optionalString(body, 'spaceKey');
        // Text with no page named, such as a pasted snippet, is sent as given, through the guard.
        let markdown = optionalString(body, 'markdown') ?? optionalString(body, 'documentMarkdown') ?? '';
        let pageTitle = optionalString(body, 'pageTitle');
        let branch = {
          pages: [] as Array<{ markdown: string; page: { title: string } }>,
          withheld: [] as string[],
          overflow: [] as string[],
        };
        if (pageId) {
          // The page that is sent is the page that was checked: the server's own copy, read by the
          // exclusion check itself. Any text or title in the request is ignored, so text from another
          // page, or from before a rule changed, can never go out under this page's name.
          const checked = await gate(pageId, spaceKey);
          spaceKey = checked.spaceKey;
          markdown = store.readableMarkdown(checked.spaceKey, checked.page);
          pageTitle = checked.page.title;
          // A page with no body of its own, such as a folder page, is answered from the pages below it.
          const ownBody = markdown.replace(/^---[\s\S]*?---\s*/m, '').trim();
          if (fields.includeChildren === true || ownBody.length < 50) {
            branch = await collectBranch(pageId, checked.spaceKey, deps, dataDir, CONTEXT_CHAR_LIMIT - markdown.length);
          }
        }
        const full =
          markdown + branch.pages.map((p) => `\n\n---\n# Sub-Page: ${p.page.title}\n${p.markdown}`).join('\n');
        if (!full.trim()) throw new HttpError(400, 'there is no page content to ask about');
        const answer = await ai.analyzeDocument(full, prompt, pageTitle, { spaceKey });
        const guard = withWithheld(answer.guard, branch.withheld);
        return {
          answer: answer.text,
          guard: { ...guard, summary: guard.summary + leftOutNote(branch) },
          engine: ai.getEngine(),
        };
      })
      .add('POST', '/api/space-cache/:spaceKey/ai/ask', async ({ params, body, signal }): Promise<AnalyzeResponse> => {
        const prompt = requiredPrompt(body);
        const key = params.spaceKey.toUpperCase();
        await index.ready(key);
        const context = await retrieveContext(
          key,
          await store.visiblePages(key),
          { question: prompt },
          { store, exclusions, dataDir, index, vectors: services.vectors, ai, signal },
          { budget: services.contextChars, outline: true },
        );
        const answer = await ai.analyzeDocument(context.contextMarkdown, prompt, `Space ${key}`, {
          spaceKey: key,
          signal,
        });
        return {
          answer: answer.text,
          guard: withWithheld(answer.guard, context.withheld),
          selectedPages: context.selectedPages,
          engine: ai.getEngine(),
        };
      })
      .add('GET', '/api/space-cache/:spaceKey/pages/:pageId/metadata', ({ params }) => ({
        metadata: store.readMetadata(params.spaceKey, params.pageId) ?? null,
      }))
      .add('POST', '/api/space-cache/:spaceKey/pages/:pageId/metadata/generate', async ({ params }) => {
        const { page, spaceKey } = await gate(params.pageId, params.spaceKey);
        const result = await generateMetadata(
          page,
          ai,
          (await tagIndex(store, spaceKey)).map((t) => t.tag),
          (p) => store.readableMarkdown(spaceKey, p),
          imagesFor((key, p) => store.attachments.of(key, p), loadSpaceSettings(dataDir, spaceKey).images, [
            { spaceKey, page },
          ]).images,
        );
        if (store.readPage(spaceKey, page.id)) store.writeMetadata(spaceKey, result);
        return { metadata: result };
      })
      .add(
        'POST',
        '/api/space-cache/:spaceKey/metadata/generate',
        async ({ params, body }): Promise<MetadataProgress> =>
          metadata.start(
            params.spaceKey,
            optionalString(body, 'rootPageId'),
            await chosenIdsOf(body, params.spaceKey, store, exclusions),
          ),
      )
      // How many of a space's, a section's or chosen pages have an AI summary, for a chat to show, and
      // whether they fit one request, so the chat can say whether it reads them all (ADR-051).
      .add('POST', '/api/space-cache/:spaceKey/metadata/coverage', async ({ params, body }) => {
        const key = params.spaceKey.toUpperCase();
        const rootPageId = optionalString(body, 'rootPageId');
        const ids = await chosenIdsOf(body, key, store, exclusions);
        // A space still being indexed answers with how far it has got rather than keep the chat waiting;
        // the chat asks again until it is done.
        const built = await Promise.race([
          index.ready(key).then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), INDEX_WAIT_MS).unref()),
        ]);
        if (!built) {
          const progress = index.building().find((b) => b.spaceKey === key);
          return {
            ...(await metadata.coverage(key, rootPageId, ids)),
            indexing: { done: progress?.done ?? 0, total: progress?.total ?? 0 },
          };
        }
        const allowed = await metadata.allowedPages(key, rootPageId, ids);
        const size = corpusSize(key, allowed, index);
        const images = imagesOnPages(key, allowed);
        return {
          ...(await metadata.coverage(key, rootPageId, ids)),
          fits: size <= services.contextChars,
          ...(images.found ? { images } : {}),
        };
      })
      .add('GET', '/api/space-cache/metadata/status/:jobId', ({ params }) => {
        const job = metadata.get(params.jobId);
        if (!job) throw new HttpError(404, `no metadata job ${params.jobId}`);
        return job;
      })
      .add('POST', '/api/space-cache/metadata/cancel/:jobId', ({ params }) => ({
        cancelled: metadata.cancel(params.jobId),
      }))
      .add('GET', '/api/space-cache/:spaceKey/metadata/active', ({ params }) => ({
        activeJob: metadata.activeFor(params.spaceKey) ?? null,
      }))
      .add('POST', '/api/space-cache/:spaceKey/metadata/cancel-active', ({ params }) => {
        const job = metadata.activeFor(params.spaceKey);
        return { cancelled: job ? metadata.cancel(job.jobId) : false };
      })
      // Whether the space's images go to the AI (ADR-066); anything but a known choice is refused.
      .add('GET', '/api/space-cache/:spaceKey/space-settings', ({ params }) =>
        loadSpaceSettings(dataDir, params.spaceKey),
      )
      .add('POST', '/api/space-cache/:spaceKey/space-settings', ({ params, body }) => {
        const images = fieldsOf(body).images;
        if (!isImageChoice(images)) throw new HttpError(400, 'images must be ask, send or skip');
        return saveSpaceSettings(dataDir, params.spaceKey, { images });
      })
      .add('GET', '/api/space-cache/:spaceKey/guard', ({ params }) => {
        const file = guardRulesPath(dataDir, params.spaceKey);
        return { text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' };
      })
      // Saved only if every rule parses, because a rule that fails to load would let through what it
      // was written to stop.
      .add('POST', '/api/space-cache/:spaceKey/guard', ({ params, body }) => {
        const text = optionalString(body, 'text') ?? '';
        try {
          parseGuardRules(text);
        } catch (error) {
          throw new HttpError(400, errorMessage(error));
        }
        const file = guardRulesPath(dataDir, params.spaceKey);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text === '' || text.endsWith('\n') ? text : `${text}\n`, 'utf8');
        return { text: fs.readFileSync(file, 'utf8') };
      })
  );
}
