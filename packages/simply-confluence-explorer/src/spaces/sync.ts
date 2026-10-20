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

import type { PageTreeNode, SyncProgress } from '../api/types.js';
import type { ConfluenceClient } from '../confluence/client.js';
import { JobRunner } from '../jobs/jobRunner.js';
import { parsePage } from '../parser/convert.js';
import { errorMessage } from '../util/errors.js';
import { runLimited } from '../util/runLimited.js';
import type { LiveJob } from '../telemetry/telemetry.js';
import { noTracer, type Tracer } from '../telemetry/tracer.js';
import type { ExclusionManager } from './exclusionManager.js';
import type { SpaceStore } from './spaceStore.js';

/** How many pages a sync reads from Confluence at once. */
const SYNC_CONCURRENCY = 4;

type Ancestors = Array<{ id: string; title: string }>;
type Planned = { node: PageTreeNode; ancestors: Ancestors };

/**
 * Copies a space, or a branch of it, from Confluence to disk. Pages that are excluded are never
 * written, and a page whose copy is already at Confluence's version is not downloaded again, so a
 * second sync of a large space reads only what changed.
 */
export class SpaceSync {
  private readonly jobs: JobRunner<SyncProgress>;

  public constructor(
    private readonly store: SpaceStore,
    private readonly exclusions: ExclusionManager,
    private readonly client: () => ConfluenceClient,
    log: (message: string) => void,
    tracer: Tracer = noTracer,
  ) {
    this.jobs = new JobRunner<SyncProgress>(
      'sync',
      (job, error) => {
        log(`sync ${job.jobId} of ${job.spaceKey} failed: ${errorMessage(error)}`);
        job.errors.push({ pageId: '', title: job.spaceKey, error: errorMessage(error) });
        job.errorCount++;
      },
      tracer,
    );
  }

  /** Syncs running now, for the Observability page. */
  public liveJobs(): LiveJob[] {
    return this.jobs.running().map((j) => ({
      jobId: j.jobId,
      kind: 'sync',
      label: `Syncing ${j.spaceKey}`,
      processed: j.processed,
      total: j.total,
      startedAt: j.startedAt,
      current: j.currentPageTitle,
    }));
  }

  /**
   * Starts a sync in the background, or returns the one already running for the space, since two
   * at once would download the same pages twice.
   *
   * @param spaceKey The space to sync.
   * @param rootPageId Sync only this page and what is below it, adding to what is already on disk.
   */
  public start(spaceKey: string, rootPageId?: string): SyncProgress {
    const key = spaceKey.trim().toUpperCase();
    const running = this.activeFor(key);
    if (running) return running;
    const fields = {
      spaceKey: key,
      total: 0,
      processed: 0,
      skippedCount: 0,
      downloadedCount: 0,
      errorCount: 0,
      errors: [],
    };
    return this.jobs.start(fields, (job) => this.run(job, key, rootPageId));
  }

  public get(jobId: string): SyncProgress | undefined {
    return this.jobs.get(jobId);
  }

  public cancel(jobId: string): boolean {
    return this.jobs.cancel(jobId) !== undefined;
  }

  /** The sync running for a space, so a browser that reloads can pick up its progress. */
  public activeFor(spaceKey: string): SyncProgress | undefined {
    const key = spaceKey.trim().toUpperCase();
    return this.jobs.find((job) => job.spaceKey === key && (job.status === 'pending' || job.status === 'running'));
  }

  private async run(job: SyncProgress, spaceKey: string, rootPageId?: string): Promise<void> {
    job.status = 'running';
    job.currentPageTitle = 'Reading the page tree';
    const client = this.client();
    const space = await client.getSpace(spaceKey);
    const tree = await client.getPageTree(spaceKey, rootPageId);
    const { visible, excluded } = this.plan(tree, spaceKey);
    job.total = visible.length + excluded;
    job.skippedCount += excluded;
    job.processed += excluded;
    const planned = visible;

    await runLimited(
      planned.map((item) => (): Promise<void> => this.syncPage(job, client, spaceKey, item)),
      SYNC_CONCURRENCY,
    );
    if (this.jobs.isCancelled(job.jobId)) return;

    const previous = (await this.store.listSynced()).find((s) => s.spaceKey === spaceKey);
    this.store.writeManifest(spaceKey, {
      spaceKey,
      name: space.name,
      // A branch sync adds to the space on disk, so the space keeps the root it was first synced from.
      rootPageId: rootPageId && previous ? previous.rootPageId : tree[0]?.id,
      rootPageTitle: rootPageId && previous ? previous.rootPageTitle : tree[0]?.title,
      lastSynced: new Date().toISOString(),
      pageCount: 0,
    });
    this.store.invalidate(spaceKey);
    await this.store.writeToc(spaceKey);
    job.currentPageTitle = undefined;
  }

  /**
   * Splits the tree into the pages to sync and a count of the pages left out. An excluded page is
   * left out together with everything below it, whichever rule excluded it, exactly as the browser's
   * tree hides it, so a page under an excluded parent never reaches the disk.
   */
  private plan(
    nodes: PageTreeNode[],
    spaceKey: string,
    ancestors: Ancestors = [],
  ): { visible: Planned[]; excluded: number } {
    const visible: Planned[] = [];
    let excluded = 0;
    for (const node of nodes) {
      if (this.exclusions.isPageExcluded({ id: node.id, title: node.title, ancestors }, spaceKey)) {
        excluded += countPages(node);
        continue;
      }
      visible.push({ node, ancestors });
      const below = this.plan(node.children, spaceKey, [...ancestors, { id: node.id, title: node.title }]);
      visible.push(...below.visible);
      excluded += below.excluded;
    }
    return { visible, excluded };
  }

  private async syncPage(
    job: SyncProgress,
    client: ConfluenceClient,
    spaceKey: string,
    { node }: Planned,
  ): Promise<void> {
    if (this.jobs.isCancelled(job.jobId)) return;
    try {
      if (this.store.cachedVersion(spaceKey, node.id) >= node.version) {
        job.skippedCount++;
        return;
      }
      job.currentPageTitle = node.title;
      const page = await client.getPageDetail(node.id);
      const attachments = await Promise.all(
        page.attachments.map(async (a) => ({ name: a.title, data: await client.downloadAttachment(a.downloadUrl) })),
      );
      this.store.writePage(spaceKey, page, parsePage(page).markdown, attachments);
      job.downloadedCount++;
    } catch (error) {
      job.errorCount++;
      job.errors.push({ pageId: node.id, title: node.title, error: errorMessage(error) });
    } finally {
      job.processed++;
    }
  }
}

const countPages = (node: PageTreeNode): number => 1 + node.children.reduce((n, c) => n + countPages(c), 0);
