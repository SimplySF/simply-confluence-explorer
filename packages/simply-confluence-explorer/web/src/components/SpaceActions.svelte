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
  import type { SyncedSpace } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { summaryAction } from '../support/summaries.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import SpaceRulesDialog from './SpaceRulesDialog.svelte';
  import TocViewer from './TocViewer.svelte';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
  import Dialog from './ui/Dialog.svelte';
  import JobProgress from './ui/JobProgress.svelte';
  import Menu from './ui/Menu.svelte';

  // Everything done to a space as a whole: sync, the AI index, its table of contents, a ZIP, and its rules.
  type Props = {
    spaceKey: string;
    /** The space's synced copy, if there is one. */
    manifest?: SyncedSpace;
    /** The synced copy changed: re-read the manifest and the tree. */
    onChanged: () => void;
    onSelectPage: (pageId: string) => void;
  };

  let { spaceKey, manifest, onChanged, onSelectPage }: Props = $props();
  let dialog = $state<'toc' | 'rules' | 'purge' | null>(null);

  // Sync and summary runs are held in the jobs store, so they keep reporting after this menu goes away.
  const sync = $derived(jobs.sync(spaceKey));
  const meta = $derived(jobs.summaries(spaceKey));
  $effect(() => jobs.onFinished((j) => j.spaceKey === spaceKey && onChanged()));

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
  const summaries = $derived(summaryAction(manifest));
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
          onSelect: () => jobs.startSync(spaceKey),
          disabled: !!sync,
        },
        {
          label: summaries.label,
          icon: Sparkles,
          hint: needSync ?? summaries.hint,
          onSelect: () => jobs.startSummaries(spaceKey),
          disabled: !synced || !!meta || !!sync || summaries.done,
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
      current={sync.current || 'Starting sync…'}
      onStop={() => jobs.stop(sync!)}
    />
  {/if}
  {#if meta}
    <JobProgress
      processed={meta.processed}
      total={meta.total}
      current={meta.current}
      onStop={() => jobs.stop(meta!)}
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
