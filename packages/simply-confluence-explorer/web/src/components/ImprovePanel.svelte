<script lang="ts">
  import { ShieldOff } from '@lucide/svelte';
  import type { BranchFinding, PageResponse } from '../../../src/api/types.js';
  import Review from './Review.svelte';

  // Improving one page: review it, choose which suggestions to apply, then read the edit, check it and
  // push it. It is the same flow as a section's or a tag's review (ADR-046), and a push names the
  // version the edit was made from, so a change made in Confluence since then is never written over.
  type Props = {
    page: PageResponse;
    spaceKey: string;
    excluded: boolean;
    /** A run the header opened, to show straight away. */
    openRunId?: string;
    onOpenPage: (pageId: string) => void;
    /** The page was written: reload it, so what is shown is what Confluence now holds. */
    onPushed: () => void;
    onWriteNewPage?: (finding: BranchFinding) => void;
  };

  let { page, spaceKey, excluded, openRunId, onOpenPage, onPushed, onWriteNewPage }: Props = $props();
  const detail = $derived(page.detail);
</script>

{#if excluded}
  <div class="alert alert-warning">
    <ShieldOff size={14} /> This page is excluded by <code>.confluenceignore</code>, so it is never sent to an AI for a
    review.
  </div>
{:else}
  <div class="improve-panel">
    {#key detail.id}
      <Review
        {spaceKey}
        source={{ kind: 'page', rootPageId: detail.id }}
        candidates={[{ id: detail.id, title: detail.title }]}
        {openRunId}
        {onOpenPage}
        {onPushed}
        {onWriteNewPage}
      />
    {/key}
  </div>
{/if}
