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

import type { MetadataProgress, PageDetail, PageMetadata } from '../api/types.js';
import type { AiEngine } from '../ai/engine.js';
import { HttpError } from '../http/router.js';
import { JobRunner } from '../jobs/jobRunner.js';
import { parsePage } from '../parser/convert.js';
import { errorMessage } from '../util/errors.js';
import { mapChunked, pause } from '../util/pause.js';
import type { LiveJob } from '../telemetry/telemetry.js';
import { noTracer, type Tracer } from '../telemetry/tracer.js';
import type { ExclusionManager } from './exclusionManager.js';
import { sectionName, splitSections } from './sections.js';
import type { SpaceStore } from './spaceStore.js';
import { generateMetadataPack, packPages, withRetry } from './indexPacks.js';
import { tagIndex } from './tags.js';
import type { VectorIndex } from './vectors.js';

/** The kind of metadata this code writes. Metadata of an older kind counts as missing and is regenerated. */
export const METADATA_VERSION = 2;

/** How many of a space's topics the prompt offers, so pages on one subject reuse one tag. */
const VOCABULARY = 60;
/** How many sections are summarised; the rest of a very long page is found by its words alone. */
const SUMMARISED_SECTIONS = 60;

function metadataPrompt(vocabulary: string[], headings: string[]): string {
  return `Analyze this Confluence page and return a JSON object with this exact schema:
{
  "summary": "1-2 sentence summary of what this page is for",
  "tags": ["3 to 6 topics, lower case"],
  "documentType": "architecture" | "runbook" | "overview" | "policy" | "guide" | "reference",
  "systemsMentioned": ["SystemA", "SystemB"],
  "audience": "who reads this page, such as on-call engineers",
  "questions": ["up to 6 questions a reader could answer from this page"],
  "sections": ["one line on what each section below says, in the same order"]
}
${vocabulary.length ? `Choose topics from this list when one fits, and add a new one only for a subject none of them covers: ${vocabulary.join(', ')}.\n` : ''}The page's sections are:
${headings.map((h, i) => `${i + 1}. ${h}`).join('\n')}
Only output the valid JSON block, with no conversational filler.`;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Whether metadata is of the kind this code writes, so a run knows to redo it. */
export function isCurrentMetadata(metadata?: Pick<PageMetadata, 'version'>): boolean {
  return (metadata?.version ?? 1) >= METADATA_VERSION;
}

/**
 * Asks the AI for a page's summary, topics, document type, systems, audience, the questions it
 * answers and a line on each section (ADR-051). A reply without a JSON object in it is an error, not
 * an empty result, so a failed summary is never saved as if it were one.
 *
 * @param page The page, which the caller has already checked is not excluded.
 * @param ai The engine to ask.
 * @param vocabulary The space's most-used topics, which the AI reuses where one fits.
 */
export async function generateMetadata(
  page: PageDetail,
  ai: AiEngine,
  vocabulary: string[] = [],
): Promise<PageMetadata> {
  const { markdown } = parsePage(page);
  const headings = splitSections(page.id, markdown)
    .slice(0, SUMMARISED_SECTIONS)
    .map((s) => sectionName(page.title, s));
  const reply = (
    await ai.analyzeDocument(markdown, metadataPrompt(vocabulary.slice(0, VOCABULARY), headings), page.title, {
      spaceKey: page.spaceKey,
    })
  ).text;
  const json = /\{[\s\S]*\}/.exec(reply);
  if (!json) throw new Error('the AI reply contained no JSON metadata');
  return toMetadata(page, JSON.parse(json[0]) as Record<string, unknown>, headings);
}

/**
 * A page's metadata from one entry of an AI reply. Each section line is matched to its section by
 * position; a section the reply skipped has no line rather than another's.
 */
export function toMetadata(page: PageDetail, m: Record<string, unknown>, headings: string[]): PageMetadata {
  const lines = strings(m.sections);
  return {
    pageId: page.id,
    title: page.title,
    summary: typeof m.summary === 'string' ? m.summary : 'Documentation page.',
    tags: strings(m.tags)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
    documentType: typeof m.documentType === 'string' ? m.documentType : 'overview',
    systemsMentioned: strings(m.systemsMentioned),
    generatedAt: new Date().toISOString(),
    version: METADATA_VERSION,
    ...(typeof m.audience === 'string' ? { audience: m.audience.slice(0, 200) } : {}),
    questions: strings(m.questions)
      .slice(0, 6)
      .map((q) => q.slice(0, 300)),
    sections: headings.map((heading, i) => ({ heading, summary: (lines[i] ?? '').slice(0, 300) })),
  };
}

/**
 * Generates AI summaries for every synced page in a space, or in one branch of it, as a background
 * job. Excluded pages are never sent, and a page that already has current metadata is skipped, so the
 * job can be run again to fill in what failed, and after a sync it redoes only the pages that changed
 * (a new version of a page removes its metadata). When the AI provider makes embeddings, each page's
 * sections are embedded after its metadata (ADR-051). The table of contents is rebuilt afterwards, because it
 * shows the summaries.
 */
export class MetadataPipeline {
  private readonly jobs: JobRunner<MetadataProgress>;

  public constructor(
    private readonly store: SpaceStore,
    private readonly exclusions: ExclusionManager,
    private readonly ai: () => AiEngine,
    log: (message: string) => void,
    private readonly vectors?: VectorIndex,
    private readonly tracer: Tracer = noTracer,
    private readonly options: { retryDelayMs?: number } = {},
  ) {
    this.jobs = new JobRunner<MetadataProgress>(
      'meta',
      (job, error) => log(`AI summaries for ${job.spaceKey} failed: ${errorMessage(error)}`),
      tracer,
    );
  }

  /** Index runs going on now, for the Observability page. */
  public liveJobs(): LiveJob[] {
    return this.jobs.running().map((j) => ({
      jobId: j.jobId,
      kind: 'index',
      label: `AI index: ${j.rootTitle ?? j.spaceKey}`,
      processed: j.processed,
      total: j.total,
      startedAt: j.startedAt,
      current: j.currentPageTitle,
    }));
  }

  /**
   * Starts a run, or returns the one already running for the same pages. Two runs in one space would
   * summarise the same pages at once and pay for each of them twice, so a run for other pages waits.
   */
  public start(spaceKey: string, rootPageId?: string, pageIds?: string[]): MetadataProgress {
    const key = spaceKey.toUpperCase();
    const running = this.activeFor(key);
    if (running && running.rootPageId === rootPageId && !pageIds && !running.chosen) return running;
    if (running)
      throw new HttpError(
        409,
        `AI summaries are already running for ${running.rootTitle ?? `all of ${key}`}. Stop that run, or wait for it to finish.`,
      );
    const rootTitle = pageIds
      ? `${pageIds.length} chosen pages`
      : rootPageId
        ? (this.store.readPage(key, rootPageId)?.title ?? rootPageId)
        : undefined;
    return this.jobs.start(
      { spaceKey: key, rootPageId, rootTitle, chosen: !!pageIds, total: 0, processed: 0, errorCount: 0 },
      (job) => this.run(job, key, rootPageId, pageIds),
    );
  }

  public get(jobId: string): MetadataProgress | undefined {
    return this.jobs.get(jobId);
  }

  public cancel(jobId: string): boolean {
    return this.jobs.cancel(jobId) !== undefined;
  }

  /** The job running for a space, so a browser that reloads can pick up its progress. */
  public activeFor(spaceKey: string): MetadataProgress | undefined {
    const key = spaceKey.toUpperCase();
    return this.jobs.find((job) => job.spaceKey === key && (job.status === 'pending' || job.status === 'running'));
  }

  /**
   * How many synced pages of a space, a section or a list there are, how many are not indexed yet,
   * and about how many requests indexing them would take, leaving out excluded pages.
   */
  public async coverage(
    spaceKey: string,
    rootPageId?: string,
    pageIds?: string[],
  ): Promise<{ pages: number; missing: number; requests: number }> {
    const key = spaceKey.toUpperCase();
    const missing = await this.missing(key, rootPageId, pageIds);
    return {
      pages: (await this.allowedPages(key, rootPageId, pageIds)).length,
      missing: missing.length,
      requests: packPages(missing).length,
    };
  }

  /** The synced pages of a space, a section or a list, leaving out excluded pages. */
  public async allowedPages(spaceKey: string, rootPageId?: string, pageIds?: string[]): Promise<PageDetail[]> {
    const key = spaceKey.toUpperCase();
    return (await this.pagesOf(key, rootPageId, pageIds)).filter((p) => !this.exclusions.isPageExcluded(p, key));
  }

  /** The pages asked for, read in chunks, as a section or a list can hold most of a large space. */
  private async pagesOf(spaceKey: string, rootPageId?: string, pageIds?: string[]): Promise<PageDetail[]> {
    if (!pageIds && !rootPageId) return this.store.visiblePages(spaceKey);
    await this.store.treeReady(spaceKey);
    const ids = pageIds ?? [rootPageId!, ...this.store.descendants(spaceKey, rootPageId!).map((n) => n.id)];
    const pages = await mapChunked(ids, (id) => this.store.readPage(spaceKey, id));
    return pages.filter((p): p is PageDetail => !!p);
  }

  /** The model the engine embeds with, when there is an index to keep its vectors in. */
  private embeddingModel(): string | null {
    return this.vectors ? (this.ai().embeddingModel?.() ?? null) : null;
  }

  /**
   * Pages with no current metadata, or, when the engine embeds, no vectors for their version. It reads
   * each page's metadata, so it lets other requests through as it goes.
   */
  private async missing(spaceKey: string, rootPageId?: string, pageIds?: string[]): Promise<PageDetail[]> {
    const model = this.embeddingModel();
    const pages = await this.pagesOf(spaceKey, rootPageId, pageIds);
    const wanted = await mapChunked(
      pages,
      (p) =>
        !this.exclusions.isPageExcluded(p, spaceKey) &&
        (!isCurrentMetadata(this.store.readMetadata(spaceKey, p.id)) || (!!model && !this.vectors?.has(p, model))),
    );
    return pages.filter((_, i) => wanted[i]);
  }

  /**
   * Indexes one pack of pages: their metadata in one request where they lack it, each page the reply
   * leaves out asked for again on its own, then their section vectors when the engine makes them.
   * Returns the topics given and the pages that failed, each with why. `done` is told of pages as they
   * finish, so a pack whose pages are asked for one at a time still shows its progress.
   */
  private async indexPack(
    pack: PageDetail[],
    spaceKey: string,
    ai: AiEngine,
    vocabulary: string[],
    stopped: () => boolean,
    done: (pages: number) => void,
  ): Promise<{ tags: string[]; failed: Array<{ page: PageDetail; error: string }> }> {
    const tags: string[] = [];
    const failed: Array<{ page: PageDetail; error: string }> = [];
    const needed = pack.filter((p) => !isCurrentMetadata(this.store.readMetadata(spaceKey, p.id)));
    const retry = <T>(fn: () => Promise<T>): Promise<T> => withRetry(fn, this.options.retryDelayMs ?? 2000, stopped);
    const results =
      needed.length > 1
        ? await retry(() => generateMetadataPack(needed, ai, vocabulary)).catch(
            // The pack request itself failed: each page is asked for on its own instead.
            (error: unknown) => new Map(needed.map((p) => [p.id, new Error(errorMessage(error))])),
          )
        : new Map<string, PageMetadata | Error>(needed.map((p) => [p.id, new Error('asked alone')]));
    done(pack.length - needed.filter((p) => results.get(p.id) instanceof Error).length);
    for (const page of needed) {
      let result = results.get(page.id);
      if (!(result instanceof Error) || stopped()) {
        if (result && !(result instanceof Error)) this.store.writeMetadata(spaceKey, result);
      } else {
        // eslint-disable-next-line no-await-in-loop -- a page left out of its pack is asked for alone, in turn
        result = await retry(() => generateMetadata(page, ai, vocabulary)).catch(
          (error: unknown) => new Error(errorMessage(error)),
        );
        if (result instanceof Error) failed.push({ page, error: result.message });
        else this.store.writeMetadata(spaceKey, result);
        done(1);
      }
      if (result && !(result instanceof Error)) tags.push(...result.tags);
    }
    await this.embedPack(
      pack.filter((p) => !failed.some((f) => f.page === p)),
      spaceKey,
      ai,
      failed,
    );
    return { tags, failed };
  }

  /** Embeds the sections of a pack's pages in as few requests as the engine allows. */
  private async embedPack(
    pages: PageDetail[],
    spaceKey: string,
    ai: AiEngine,
    failed: Array<{ page: PageDetail; error: string }>,
  ): Promise<void> {
    const model = this.embeddingModel();
    if (!model || !ai.embed || !this.vectors) return;
    const todo = pages.filter((p) => !this.vectors!.has(p, model));
    if (todo.length === 0) return;
    const texts = todo.map((page) =>
      splitSections(page.id, parsePage(page).markdown).map((s) => `${sectionName(page.title, s)}\n\n${s.text}`),
    );
    try {
      const vectors = await ai.embed(texts.flat(), { spaceKey });
      let at = 0;
      todo.forEach((page, i) => {
        this.vectors!.write(page, model, vectors.slice(at, at + texts[i].length));
        at += texts[i].length;
      });
    } catch (error) {
      for (const page of todo) failed.push({ page, error: `its sections were not embedded: ${errorMessage(error)}` });
    }
  }

  private async run(job: MetadataProgress, spaceKey: string, rootPageId?: string, pageIds?: string[]): Promise<void> {
    job.status = 'running';
    const ai = this.ai();
    // The request that started the run is answered before the pages are looked at.
    await pause();
    const targets = await this.missing(spaceKey, rootPageId, pageIds);
    const packs = packPages(targets);
    job.total = targets.length;
    job.requests = packs.length;
    job.requestsDone = 0;
    // The topics already in use, counted as the run tags pages, so later pages reuse earlier pages' topics.
    const uses = new Map((await tagIndex(this.store, spaceKey)).map((t) => [t.tag, t.pages.length]));
    const stopped = (): boolean => this.jobs.isCancelled(job.jobId);
    const inFlight = new Set<string>();
    let next = 0;
    // A few packs at a time: a space has thousands of pages, and providers limit request rates.
    const worker = async (): Promise<void> => {
      while (next < packs.length && !stopped()) {
        const pack = packs[next++];
        const vocabulary = [...uses].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
        inFlight.add(pack[0].title);
        let counted = 0;
        job.currentPageTitle = [...inFlight].join(', ');
        // eslint-disable-next-line no-await-in-loop -- each worker takes the next pack when its last is done
        const { tags, failed } = await this.tracer.span(
          'index',
          'pack',
          { pages: pack.length, first: pack[0].title, spaceKey },
          async (span) => {
            const outcome = await this.indexPack(pack, spaceKey, ai, vocabulary, stopped, (n) => {
              counted += n;
              job.processed += n;
            });
            span.set({ failed: outcome.failed.length });
            return outcome;
          },
        );
        inFlight.delete(pack[0].title);
        for (const tag of tags) uses.set(tag, (uses.get(tag) ?? 0) + 1);
        for (const f of failed) this.recordFailure(job, f.page, f.error, spaceKey);
        this.tracer.count('index.pages', pack.length - failed.length);
        // Pages a stopped pack never reached are counted with it, so the total adds up when the run ends.
        job.processed += pack.length - counted;
        job.requestsDone = (job.requestsDone ?? 0) + 1;
        // A reply that comes back at once, as from a cache or a stand-in, would otherwise run every
        // pack without ever letting another request through.
        // eslint-disable-next-line no-await-in-loop -- the pause is the point
        await pause();
      }
    };
    const parallel = Math.max(1, Math.min(ai.parallel?.() ?? 1, packs.length));
    await Promise.all(Array.from({ length: parallel }, worker));
    job.currentPageTitle = undefined;
    await this.store.writeToc(spaceKey);
    if (job.errorCount > 0)
      this.tracer.problem(
        'index-failures',
        `The AI index of ${job.rootTitle ?? spaceKey} left out ${job.errorCount} page${job.errorCount === 1 ? '' : 's'}.`,
      );
  }

  /** Records a page left out with its reason; running the job again retries every page still missing. */
  private recordFailure(job: MetadataProgress, page: PageDetail, error: string, spaceKey: string): void {
    job.errorCount++;
    job.failures = [...(job.failures ?? []), { pageId: page.id, title: page.title, error }].slice(-200);
    this.tracer.count('index.failures');
    // The reason alone is the message, so copies of one failure group together; the page is an attribute.
    this.tracer.log('warn', 'index', `A page was not indexed: ${error}`, {
      pageId: page.id,
      title: page.title,
      spaceKey,
    });
  }
}
