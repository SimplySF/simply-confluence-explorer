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

import type { ConfluenceSpace, DeleteProgress, PageTreeNode, SyncProgress } from '../api/types.js';
import { HttpError } from '../http/router.js';
import type { ConfluenceClient } from '../confluence/client.js';
import { JobRunner } from '../jobs/jobRunner.js';
import { parsePage } from '../parser/convert.js';
import { errorMessage } from '../util/errors.js';
import { runLimited } from '../util/runLimited.js';
import type { LiveJob } from '../telemetry/telemetry.js';
import { noTracer, type Tracer } from '../telemetry/tracer.js';
import type { ExclusionManager } from './exclusionManager.js';
import { deleteFiles, type SpaceStore } from './spaceStore.js';

/** How many pages a sync reads from Confluence at once. */
const SYNC_CONCURRENCY = 4;

type Ancestors = Array<{ id: string; title: string }>;
type Planned = { node: PageTreeNode; ancestors: Ancestors };

/**
 * Copies a space, or a branch of it, from Confluence to disk. Pages that are excluded are never
 * written, and a page whose copy is already at Confluence's version is not downloaded again, so a
 * second sync of a large space reads only what changed. A page is fetched again at the same version
 * when a file it lists is not on disk, or when an attachment of it changed in Confluence since the
 * last sync, since neither changes the page's version.
 */
export class SpaceSync {
  private readonly jobs: JobRunner<SyncProgress>;
  private readonly deletions: JobRunner<DeleteProgress>;

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
        log(`Sync of ${job.spaceKey} started at ${job.startedAt ?? 'an unknown time'} failed ${errorMessage(error)}`);
        job.errors.push({ pageId: '', title: job.spaceKey, error: errorMessage(error) });
        job.errorCount++;
      },
      tracer,
    );
    this.deletions = new JobRunner<DeleteProgress>(
      'delete',
      (job, error) => {
        log(`deleting the copy of ${job.spaceKey} failed: ${errorMessage(error)}`);
        job.error = errorMessage(error);
      },
      tracer,
    );
  }

  /**
   * Starts deleting the copy of a space, in the background. The copy is moved aside first, so the
   * space reads as not synced at once and can be synced again while the old files go.
   */
  public startDelete(spaceKey: string): DeleteProgress {
    const key = spaceKey.trim().toUpperCase();
    const running = this.deleting(key);
    if (running) return running;
    const { deletedPages, targets, inPlace } = this.store.setAside(key);
    return this.deletions.start({ spaceKey: key, deletedPages, total: 0, processed: 0, inPlace }, async (job) => {
      job.status = 'running';
      await deleteFiles(
        targets,
        (done, total, current) => {
          job.processed = done;
          job.total = total;
          job.currentFile = current || undefined;
        },
        () => this.deletions.isCancelled(job.jobId),
      );
    });
  }

  public deleteStatus(jobId: string): DeleteProgress | undefined {
    return this.deletions.get(jobId);
  }

  public cancelDelete(jobId: string): boolean {
    return this.deletions.cancel(jobId) !== undefined;
  }

  /** The deletion running for a space, so a browser that reloads can pick up its progress. */
  public deleting(spaceKey: string): DeleteProgress | undefined {
    const key = spaceKey.trim().toUpperCase();
    return this.deletions.find((j) => j.spaceKey === key && (j.status === 'pending' || j.status === 'running'));
  }

  /** Syncs running now, for the Observability page. */
  public liveJobs(): LiveJob[] {
    return [
      ...this.jobs.running().map((j) => ({
        jobId: j.jobId,
        kind: 'sync',
        label: `Syncing ${j.spaceKey}`,
        processed: j.processed,
        total: j.total,
        startedAt: j.startedAt,
        current: j.currentPageTitle,
      })),
      ...this.deletions.running().map((j) => ({
        jobId: j.jobId,
        kind: 'delete',
        label: `Deleting the copy of ${j.spaceKey}`,
        processed: j.processed,
        total: j.total,
        startedAt: j.startedAt,
        current: j.currentFile,
      })),
    ];
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
    if (this.deleting(key)?.inPlace)
      throw new HttpError(409, `the copy of ${key} is still being deleted; sync it again once that is done`);
    const fields = {
      spaceKey: key,
      total: 0,
      processed: 0,
      skippedCount: 0,
      downloadedCount: 0,
      attachmentsDownloaded: 0,
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
    let space: ConfluenceSpace;
    let tree: PageTreeNode[];
    try {
      space = await client.getSpace(spaceKey);
      tree = await client.getPageTree(spaceKey, rootPageId, (found) => {
        job.currentPageTitle = `Reading the page tree: ${found} page${found === 1 ? '' : 's'} found`;
      });
    } catch (error) {
      // Said with the step, so a failure reads as this sync's and not as a page's.
      throw new Error(`while reading the page tree: ${errorMessage(error)}`, { cause: error });
    }
    const { visible, excluded } = this.plan(tree, spaceKey);
    job.total = visible.length + excluded;
    job.skippedCount += excluded;
    job.processed += excluded;
    const planned = visible;
    const previous = (await this.store.listSynced()).find((s) => s.spaceKey === spaceKey);
    const changed = previous ? await changedAttachments(job, client, spaceKey, previous.lastSynced) : new Set<string>();

    await runLimited(
      planned.map((item) => (): Promise<void> => this.syncPage(job, client, spaceKey, item, changed)),
      SYNC_CONCURRENCY,
    );
    if (this.jobs.isCancelled(job.jobId)) return;

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
    changed: ReadonlySet<string>,
  ): Promise<void> {
    if (this.jobs.isCancelled(job.jobId)) return;
    try {
      const cached = this.store.readPage(spaceKey, node.id);
      const current =
        cached &&
        cached.version >= node.version &&
        !changed.has(node.id) &&
        !this.store.attachmentEntries(spaceKey, cached).some((a) => a.missing);
      if (current) {
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
      job.attachmentsDownloaded += attachments.length;
    } catch (error) {
      job.errorCount++;
      job.errors.push({ pageId: node.id, title: node.title, error: errorMessage(error) });
    } finally {
      job.processed++;
    }
  }
}

/**
 * The pages whose attachments changed in Confluence since the last sync. A failed search does not
 * stop the sync; the result says what it could not check.
 */
async function changedAttachments(
  job: SyncProgress,
  client: ConfluenceClient,
  spaceKey: string,
  lastSynced: string,
): Promise<Set<string>> {
  try {
    return await client.changedAttachments(spaceKey, new Date(lastSynced));
  } catch (error) {
    job.note = `Attachments added or replaced in Confluence since the last sync may be missing: searching for them failed (${errorMessage(error)}).`;
    return new Set();
  }
}

const countPages = (node: PageTreeNode): number => 1 + node.children.reduce((n, c) => n + countPages(c), 0);
