<script lang="ts">
  import { RefreshCw, Trash2 } from '@lucide/svelte';
  import type { PageDetail } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';

  // Removes a page's synced copy from this machine; Confluence itself is not touched.
  type Props = {
    detail: PageDetail;
    spaceKey: string;
    descendantCount: number;
    onClose: () => void;
    onPurged: () => void;
  };

  let { detail, spaceKey, descendantCount, onClose, onPurged }: Props = $props();
  let withSubPages = $state(true);
  let addToIgnore = $state(true);
  let busy = $state(false);

  async function purge(): Promise<void> {
    busy = true;
    try {
      const r = await api.purgePage(spaceKey, detail.id, { includeSubPages: withSubPages, addToIgnore });
      toast(`Removed ${r.purgedCount} page${r.purgedCount === 1 ? '' : 's'} from this machine.`, 'success');
      onPurged();
    } catch (e) {
      toast(`Not removed: ${messageOf(e)}`, 'error');
      busy = false;
    }
  }
</script>

<ConfirmDialog title="Remove “{detail.title}” from this machine?" danger {busy} onCancel={onClose} onConfirm={purge}>
  {#snippet confirmLabel()}
    {#if busy}<RefreshCw size={13} class="spin" />{:else}<Trash2 size={13} />{/if} Remove from this machine
  {/snippet}
  <p>
    Deletes the synced copy of this page (its Markdown file, cache and AI index entry) and removes it from the table of
    contents. <strong>The page in Confluence is not changed.</strong>
  </p>
  {#if descendantCount > 0}
    <label class="checkbox-group">
      <input type="checkbox" bind:checked={withSubPages} />
      <span>Also remove its <strong>{descendantCount}</strong> sub-pages</span>
    </label>
  {/if}
  <label class="checkbox-group">
    <input type="checkbox" bind:checked={addToIgnore} />
    <span
      >Add it to <code>.confluenceignore</code>, so syncing does not bring it back and it is never sent to an AI</span
    >
  </label>
</ConfirmDialog>
