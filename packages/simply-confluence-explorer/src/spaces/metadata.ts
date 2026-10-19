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
import type { ExclusionManager } from './exclusionManager.js';
import type { SpaceStore } from './spaceStore.js';

const METADATA_PROMPT = `Analyze this Confluence page and return a JSON object with this exact schema:
{
  "summary": "1-2 sentence executive summary of this page",
  "tags": ["tag1", "tag2", "tag3", "tag4"],
  "documentType": "architecture" | "runbook" | "overview" | "policy" | "guide" | "reference",
  "systemsMentioned": ["SystemA", "SystemB"]
}
Only output the valid JSON block, with no conversational filler.`;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * Asks the AI for a summary, tags, a document type and the systems a page mentions. A reply without
 * a JSON object in it is an error, not an empty result, so a failed summary is never saved as if it
 * were one.
 *
 * @param page The page, which the caller has already checked is not excluded.
 * @param ai The engine to ask.
 */
export async function generateMetadata(page: PageDetail, ai: AiEngine): Promise<PageMetadata> {
  const reply = (
    await ai.analyzeDocument(parsePage(page).markdown, METADATA_PROMPT, page.title, { spaceKey: page.spaceKey })
  ).text;
  const json = /\{[\s\S]*\}/.exec(reply);
  if (!json) throw new Error('the AI reply contained no JSON metadata');
  const m = JSON.parse(json[0]) as Record<string, unknown>;
  return {
    pageId: page.id,
    title: page.title,
    summary: typeof m.summary === 'string' ? m.summary : 'Documentation page.',
    tags: strings(m.tags),
    documentType: typeof m.documentType === 'string' ? m.documentType : 'overview',
    systemsMentioned: strings(m.systemsMentioned),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generates AI summaries for every synced page in a space, or in one branch of it, as a background
 * job. Excluded pages are never sent, and a page that already has a summary is skipped, so the job
 * can be run again to fill in what failed. The table of contents is rebuilt afterwards, because it
 * shows the summaries.
 */
export class MetadataPipeline {
  private readonly jobs: JobRunner<MetadataProgress>;

  public constructor(
    private readonly store: SpaceStore,
    private readonly exclusions: ExclusionManager,
    private readonly ai: () => AiEngine,
    log: (message: string) => void,
  ) {
    this.jobs = new JobRunner<MetadataProgress>('meta', (job, error) =>
      log(`AI summaries for ${job.spaceKey} failed: ${errorMessage(error)}`),
    );
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
    const pages = this.pagesOf(key, rootPageId, pageIds).filter((p) => !this.exclusions.isPageExcluded(p, key));
    return { pages: pages.length, missing: this.missing(key, rootPageId, pageIds).length };
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

  private missing(spaceKey: string, rootPageId?: string, pageIds?: string[]): PageDetail[] {
    return this.pagesOf(spaceKey, rootPageId, pageIds).filter(
      (p) => !this.exclusions.isPageExcluded(p, spaceKey) && !this.store.readMetadata(spaceKey, p.id),
    );
  }

  private async run(job: MetadataProgress, spaceKey: string, rootPageId?: string, pageIds?: string[]): Promise<void> {
    job.status = 'running';
    const ai = this.ai();
    const targets = this.missing(spaceKey, rootPageId, pageIds);
    job.total = targets.length;
    // One page at a time: a space can have thousands of pages, and providers limit request rates.
    for (const page of targets) {
      if (this.jobs.isCancelled(job.jobId)) return;
      job.currentPageTitle = page.title;
      try {
        // eslint-disable-next-line no-await-in-loop -- one request at a time, as explained above
        this.store.writeMetadata(spaceKey, await generateMetadata(page, ai));
      } catch {
        // Counted and skipped; running the job again retries every page still without a summary.
        job.errorCount++;
      }
      job.processed++;
    }
    job.currentPageTitle = undefined;
    this.store.writeToc(spaceKey);
  }
}
