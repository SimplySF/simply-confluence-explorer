<script lang="ts">
  import { Download, Ellipsis, FolderSync, FolderTree, FolderX, ShieldCheck, Sparkles, Trash2 } from '@lucide/svelte';
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

  // Everything done to a space as a whole: sync and its exclusions at hand, and in the menu the AI index,
  // its table of contents, a ZIP, removing stale pages, and deleting the copy of the space.
  type Props = {
    spaceKey: string;
    /** The space's synced copy, if there is one. */
    manifest?: SyncedSpace;
    /** The synced copy changed: re-read the manifest and the tree. */
    onChanged: () => void;
    onSelectPage: (pageId: string) => void;
  };

  let { spaceKey, manifest, onChanged, onSelectPage }: Props = $props();
  let dialog = $state<'toc' | 'rules' | 'purge' | 'delete' | null>(null);

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

  const deleting = $derived(jobs.deleting(spaceKey));
  let asking = $state(false);
  async function deleteSpace(): Promise<void> {
    asking = true;
    const started = await jobs.startDelete(spaceKey);
    asking = false;
    if (!started) return;
    dialog = null;
    // The copy is moved aside at once, so the space reads as not synced while its files go.
    onChanged();
  }

  function downloadZip(): void {
    const link = document.createElement('a');
    link.href = api.zipUrl(spaceKey);
    link.download = '';
    link.click();
  }

  const synced = $derived(!!manifest);
  const needSync = $derived(synced ? undefined : 'Sync the space first');
  // What a run would cost, read again whenever the synced copy or its index changes.
  let estimate = $state<{ missing: number; requests?: number } | undefined>(undefined);
  $effect(() => {
    void manifest?.metadataCount;
    void manifest?.lastSynced;
    if (!manifest) return;
    api.summaryCoverage(spaceKey, {}).then(
      (c) => (estimate = c),
      () => (estimate = undefined), // The menu still offers the run, without the estimate.
    );
  });
  const summaries = $derived(summaryAction(manifest, estimate));
</script>

<div class="space-actions">
  <div class="space-actions-row">
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      onclick={() => jobs.startSync(spaceKey)}
      disabled={!!sync}
      title="Download changed pages to this machine"
    >
      <FolderSync size={13} />
      {synced ? 'Update' : 'Sync'}
    </button>
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      onclick={() => (dialog = 'rules')}
      title="Exclusions and leak guard: what is never sent to an AI"
    >
      <ShieldCheck size={13} /> Exclusions
    </button>
    <Menu
      title="More for {spaceKey}"
      buttonClass="btn btn-secondary btn-sm space-actions-more"
      items={[
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
          label: 'Remove stale cached pages…',
          icon: Trash2,
          danger: true,
          hint: needSync ?? 'Pages no longer on disk or now excluded',
          onSelect: () => (dialog = 'purge'),
          disabled: !synced,
        },
        {
          label: `Delete the copy of ${spaceKey}…`,
          icon: FolderX,
          danger: true,
          hint:
            needSync ??
            (sync || meta ? 'Stop the running sync or index run first' : 'Every page and file on this machine'),
          onSelect: () => (dialog = 'delete'),
          disabled: !synced || !!sync || !!meta || !!deleting,
        },
      ]}
    >
      {#snippet label()}<Ellipsis size={14} />{/snippet}
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
  {#if deleting}
    <JobProgress
      processed={deleting.processed}
      total={deleting.total}
      current={deleting.current}
      onStop={() => jobs.stop(deleting!)}
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
  {:else if dialog === 'delete'}
    <ConfirmDialog
      title="Delete the copy of {spaceKey} on this machine?"
      danger
      busy={asking}
      onConfirm={() => void deleteSpace()}
      onCancel={() => (dialog = null)}
    >
      {#snippet confirmLabel()}{#if asking}<span class="spinner" aria-hidden="true"></span>{:else}<FolderX
            size={14}
          />{/if} Delete{/snippet}
      <p>
        Deletes every synced page of {spaceKey}{manifest ? ` (${manifest.pageCount})` : ''} with its attachments, AI index
        and table of contents. Its exclusions, leak-guard rules and image choice are kept, and so are its chats. Confluence
        is not changed; sync the space again to bring it back.
      </p>
    </ConfirmDialog>
  {/if}
</div>
