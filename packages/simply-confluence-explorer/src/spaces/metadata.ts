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
import type { LiveJob } from '../telemetry/telemetry.js';
import { noTracer, type Tracer } from '../telemetry/tracer.js';
import type { ExclusionManager } from './exclusionManager.js';
import { sectionName, splitSections } from './sections.js';
import type { SpaceStore } from './spaceStore.js';
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
  const m = JSON.parse(json[0]) as Record<string, unknown>;
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
    // Matched to the sections by position; a section the reply skipped has no line rather than another's.
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
   * The synced pages of a space, a section or a list that have no summary yet, leaving out excluded
   * pages, and how many pages were looked at.
   */
  public coverage(spaceKey: string, rootPageId?: string, pageIds?: string[]): { pages: number; missing: number } {
    const key = spaceKey.toUpperCase();
    return {
      pages: this.allowedPages(key, rootPageId, pageIds).length,
      missing: this.missing(key, rootPageId, pageIds).length,
    };
  }

  /** The synced pages of a space, a section or a list, leaving out excluded pages. */
  public allowedPages(spaceKey: string, rootPageId?: string, pageIds?: string[]): PageDetail[] {
    const key = spaceKey.toUpperCase();
    return this.pagesOf(key, rootPageId, pageIds).filter((p) => !this.exclusions.isPageExcluded(p, key));
  }

  private pagesOf(spaceKey: string, rootPageId?: string, pageIds?: string[]): PageDetail[] {
    const read = (id: string): PageDetail | undefined => this.store.readPage(spaceKey, id);
    if (pageIds) return pageIds.map(read).filter((p): p is PageDetail => !!p);
    if (rootPageId)
      return [rootPageId, ...this.store.descendants(spaceKey, rootPageId).map((n) => n.id)]
        .map(read)
        .filter((p): p is PageDetail => !!p);
    return this.store.visiblePages(spaceKey);
  }

  /** The model the engine embeds with, when there is an index to keep its vectors in. */
  private embeddingModel(): string | null {
    return this.vectors ? (this.ai().embeddingModel?.() ?? null) : null;
  }

  /** Pages with no current metadata, or, when the engine embeds, no vectors for their version. */
  private missing(spaceKey: string, rootPageId?: string, pageIds?: string[]): PageDetail[] {
    const model = this.embeddingModel();
    return this.pagesOf(spaceKey, rootPageId, pageIds).filter(
      (p) =>
        !this.exclusions.isPageExcluded(p, spaceKey) &&
        (!isCurrentMetadata(this.store.readMetadata(spaceKey, p.id)) || (!!model && !this.vectors?.has(p, model))),
    );
  }

  /**
   * Gives one page current metadata if it has none, then section vectors if the engine makes them.
   * Returns the topics it gave the page, for the run's shared list.
   */
  private async index(page: PageDetail, spaceKey: string, ai: AiEngine, vocabulary: string[]): Promise<string[]> {
    let tags: string[] = [];
    if (!isCurrentMetadata(this.store.readMetadata(spaceKey, page.id))) {
      const metadata = await generateMetadata(page, ai, vocabulary);
      this.store.writeMetadata(spaceKey, metadata);
      tags = metadata.tags;
    }
    const model = this.embeddingModel();
    if (model && ai.embed && this.vectors && !this.vectors.has(page, model)) {
      const texts = splitSections(page.id, parsePage(page).markdown).map(
        (section) => `${sectionName(page.title, section)}\n\n${section.text}`,
      );
      this.vectors.write(page, model, await ai.embed(texts, { spaceKey }));
    }
    return tags;
  }

  private async run(job: MetadataProgress, spaceKey: string, rootPageId?: string, pageIds?: string[]): Promise<void> {
    job.status = 'running';
    const ai = this.ai();
    const targets = this.missing(spaceKey, rootPageId, pageIds);
    job.total = targets.length;
    // The topics already in use, counted as the run tags pages, so later pages reuse earlier pages' topics.
    const uses = new Map(tagIndex(this.store, spaceKey).map((t) => [t.tag, t.pages.length]));
    // One page at a time: a space can have thousands of pages, and providers limit request rates.
    for (const page of targets) {
      if (this.jobs.isCancelled(job.jobId)) return;
      job.currentPageTitle = page.title;
      const vocabulary = [...uses].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
      try {
        // eslint-disable-next-line no-await-in-loop -- one request at a time, as explained above
        const tags = await this.tracer.span('index', 'page', { pageId: page.id, title: page.title }, () =>
          this.index(page, spaceKey, ai, vocabulary),
        );
        for (const tag of tags) uses.set(tag, (uses.get(tag) ?? 0) + 1);
        this.tracer.count('index.pages');
      } catch (error) {
        // Recorded with its reason and skipped; running the job again retries every page still missing.
        job.errorCount++;
        job.failures = [
          ...(job.failures ?? []),
          { pageId: page.id, title: page.title, error: errorMessage(error) },
        ].slice(-200);
        this.tracer.count('index.failures');
        // The reason alone is the message, so copies of one failure group together; the page is an attribute.
        this.tracer.log('warn', 'index', `A page was not indexed: ${errorMessage(error)}`, {
          pageId: page.id,
          title: page.title,
          spaceKey,
        });
      }
      job.processed++;
    }
    job.currentPageTitle = undefined;
    this.store.writeToc(spaceKey);
    if (job.errorCount > 0)
      this.tracer.problem(
        'index-failures',
        `The AI index of ${job.rootTitle ?? spaceKey} left out ${job.errorCount} page${job.errorCount === 1 ? '' : 's'}.`,
      );
  }
}
