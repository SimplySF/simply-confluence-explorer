<script lang="ts">
  import {
    CheckCircle2,
    ChevronDown,
    Download,
    FolderSync,
    FolderTree,
    HardDrive,
    ShieldCheck,
    Sparkles,
    Trash2,
  } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import type { MetadataProgress, SyncProgress, SyncedSpace } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { pollJob } from '../support/poll.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import SpaceRulesDialog from './SpaceRulesDialog.svelte';
  import TocViewer from './TocViewer.svelte';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
  import Dialog from './ui/Dialog.svelte';
  import JobProgress from './ui/JobProgress.svelte';
  import Menu from './ui/Menu.svelte';

  // Everything done to a space as a whole: sync, AI summaries, its table of contents, a ZIP, and its rules.
  type Props = {
    spaceKey: string;
    /** The space's synced copy, if there is one. */
    manifest?: SyncedSpace;
    /** The synced copy changed: re-read the manifest and the tree. */
    onChanged: () => void;
    onSelectPage: (pageId: string) => void;
  };

  let { spaceKey, manifest, onChanged, onSelectPage }: Props = $props();
  let sync = $state<SyncProgress | null>(null);
  let meta = $state<MetadataProgress | null>(null);
  let dialog = $state<'toc' | 'rules' | 'purge' | null>(null);
  let stopSyncPoll = (): void => undefined;
  let stopMetaPoll = (): void => undefined;
  onDestroy(() => {
    stopSyncPoll();
    stopMetaPoll();
  });

  const running = (status: string): boolean => status === 'running' || status === 'pending';

  function watchMeta(job: MetadataProgress): void {
    meta = job;
    stopMetaPoll();
    stopMetaPoll = pollJob(() => api.metadataStatus(job.jobId), {
      onProgress: (p) => (meta = p),
      onFinished: (p) => {
        meta = null;
        onChanged();
        toast(
          p.status === 'completed' ? `AI summaries ready for ${spaceKey}.` : `AI summaries ${p.status}.`,
          p.status === 'completed' ? 'success' : 'info',
        );
      },
      onError: () => (meta = null),
    });
  }

  // A summary run outlives a page reload, so one already running is picked up again.
  $effect(() => {
    const key = spaceKey;
    meta = null;
    stopMetaPoll();
    api.activeMetadata(key).then(
      (job) => job && running(job.status) && watchMeta(job),
      () => undefined, // No run in progress is the common answer, and there is nothing to show.
    );
  });

  async function startSync(): Promise<void> {
    try {
      const started = await api.sync(spaceKey);
      sync = started;
      stopSyncPoll = pollJob(
        () => api.syncStatus(started.jobId),
        {
          onProgress: (p) => (sync = p),
          onFinished: (p) => {
            sync = null;
            onChanged();
            toast(
              p.status === 'completed'
                ? `${spaceKey} synced: ${p.downloadedCount} page${p.downloadedCount === 1 ? '' : 's'} downloaded, ${p.skippedCount} already current or excluded.`
                : `Sync ${p.status}${p.errors.length ? `: ${p.errors[0].error}` : ''}.`,
              p.status === 'completed' ? 'success' : 'error',
            );
          },
          onError: (e) => {
            sync = null;
            toast(`Sync stopped reporting: ${messageOf(e)}`, 'error');
          },
        },
        400,
      );
    } catch (e) {
      toast(`Sync did not start: ${messageOf(e)}`, 'error');
    }
  }

  async function stopSync(): Promise<void> {
    if (!sync) return;
    try {
      await api.cancelSync(sync.jobId);
    } catch (e) {
      toast(`Could not stop the sync: ${messageOf(e)}`, 'error');
    }
    stopSyncPoll();
    sync = null;
  }

  async function startMeta(): Promise<void> {
    try {
      const { jobId } = await api.generateMetadata(spaceKey);
      watchMeta({
        jobId,
        status: 'running',
        spaceKey,
        total: manifest?.pageCount ?? 0,
        processed: manifest?.metadataCount ?? 0,
        errorCount: 0,
        currentPageTitle: 'Starting…',
      });
    } catch (e) {
      toast(`AI summaries did not start: ${messageOf(e)}`, 'error');
    }
  }

  async function pauseMeta(): Promise<void> {
    if (!meta) return;
    try {
      await api.cancelMetadata(meta.jobId);
    } catch (e) {
      toast(`Could not pause the AI summaries: ${messageOf(e)}`, 'error');
    }
    stopMetaPoll();
    meta = null;
    onChanged();
  }

  async function purgeStale(): Promise<void> {
    dialog = null;
    try {
      const r = await api.purgeStale(spaceKey);
      toast(
        `Removed ${r.purgedCount} cached page${r.purgedCount === 1 ? '' : 's'}; ${r.remainingPages} remain.`,
        'success',
      );
      onChanged();
    } catch (e) {
      toast(`Nothing removed: ${messageOf(e)}`, 'error');
    }
  }

  function downloadZip(): void {
    const link = document.createElement('a');
    link.href = api.zipUrl(spaceKey);
    link.download = '';
    link.click();
  }

  const synced = $derived(!!manifest);
  const needSync = $derived(synced ? undefined : 'Sync the space first');
  const metaLabel = $derived.by(() => {
    if (!manifest) return 'Generate AI summaries';
    if (manifest.metadataCount > 0 && manifest.metadataCount < manifest.pageCount)
      return `Resume AI summaries (${manifest.metadataCount}/${manifest.pageCount})`;
    if (manifest.pageCount > 0 && manifest.metadataCount >= manifest.pageCount) return 'Regenerate AI summaries';
    return 'Generate AI summaries';
  });
</script>

<div class="space-actions">
  <div class="space-actions-row">
    {#if manifest}
      <span class="pill pill-ok" title="Synced {new Date(manifest.lastSynced).toLocaleString()}">
        <CheckCircle2 size={12} />
        {manifest.pageCount} pages synced{manifest.hasTOC ? ' · TOC' : ''}
      </span>
    {:else}
      <span class="pill pill-warn"><HardDrive size={12} /> Not synced</span>
    {/if}
    <Menu
      title="Actions for {spaceKey}"
      items={[
        {
          label: synced ? 'Update space' : 'Sync space',
          icon: FolderSync,
          hint: 'Download changed pages to this machine',
          onSelect: startSync,
          disabled: !!sync,
        },
        {
          label: metaLabel,
          icon: Sparkles,
          hint: needSync ?? 'Summaries and tags for every page, and the table of contents',
          onSelect: startMeta,
          disabled: !synced || !!meta || !!sync,
        },
        {
          label: 'Table of contents',
          icon: FolderTree,
          hint: needSync,
          onSelect: () => (dialog = 'toc'),
          disabled: !synced,
        },
        {
          label: 'Download ZIP',
          icon: Download,
          hint: needSync ?? 'The synced copy as Markdown files',
          disabled: !synced || !!sync,
          onSelect: downloadZip,
        },
        'divider',
        {
          label: 'Exclusions and leak guard…',
          icon: ShieldCheck,
          hint: 'What is never sent to an AI',
          onSelect: () => (dialog = 'rules'),
        },
        {
          label: 'Remove stale cached pages…',
          icon: Trash2,
          danger: true,
          hint: needSync ?? 'Pages no longer on disk or now excluded',
          onSelect: () => (dialog = 'purge'),
          disabled: !synced,
        },
      ]}
    >
      {#snippet label()}Space <ChevronDown size={12} />{/snippet}
    </Menu>
  </div>

  {#if sync}
    <JobProgress
      processed={sync.processed}
      total={sync.total}
      current={sync.currentPageTitle || 'Starting sync…'}
      onStop={stopSync}
    />
  {/if}
  {#if meta}
    <JobProgress
      processed={meta.processed}
      total={meta.total}
      current={meta.currentPageTitle}
      onStop={pauseMeta}
      stopLabel="Pause"
    />
  {/if}

  {#if dialog === 'toc'}
    <Dialog size="toc-panel" bodyClass="flush" closeOnBackdrop onClose={() => (dialog = null)}>
      {#snippet header()}<FolderTree size={16} /> {spaceKey} table of contents{/snippet}
      <TocViewer
        {spaceKey}
        onSelectPage={(id) => {
          dialog = null;
          onSelectPage(id);
        }}
      />
    </Dialog>
  {:else if dialog === 'rules'}
    <SpaceRulesDialog {spaceKey} onClose={() => (dialog = null)} onSaved={onChanged} />
  {:else if dialog === 'purge'}
    <ConfirmDialog
      title="Remove stale cached pages from {spaceKey}?"
      danger
      onConfirm={purgeStale}
      onCancel={() => (dialog = null)}
    >
      {#snippet confirmLabel()}Remove{/snippet}
      <p>
        Deletes cached copies of pages that are no longer on disk or that the space's exclusions now match. Confluence
        is not changed.
      </p>
    </ConfirmDialog>
  {/if}
</div>
