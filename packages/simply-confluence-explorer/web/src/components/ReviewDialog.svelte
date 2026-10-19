<script lang="ts">
  import { FolderTree, Tag } from '@lucide/svelte';
  import type { BranchFinding, ReviewSource } from '../../../src/api/types.js';
  import Review from './Review.svelte';
  import Dialog from './ui/Dialog.svelte';

  // A review of a section or of a tag's pages, in a dialog over the page (ADR-046). A page's own
  // review is the same flow, on its Improve tab.
  type Props = {
    spaceKey: string;
    source: ReviewSource;
    title: string;
    candidates?: Array<{ id: string; title: string; depth?: number; path?: string }>;
    openRunId?: string;
    onClose: () => void;
    onOpenPage: (pageId: string) => void;
    onPushed: () => void;
    onWriteNewPage?: (finding: BranchFinding) => void;
  };

  let { spaceKey, source, title, candidates, openRunId, onClose, onOpenPage, onPushed, onWriteNewPage }: Props =
    $props();
</script>

<Dialog size="branch-workspace" {onClose}>
  {#snippet header()}
    {#if source.kind === 'tag'}<Tag size={16} />{:else}<FolderTree size={16} />{/if}
    Review: {title}
  {/snippet}
  <Review {spaceKey} {source} {candidates} {openRunId} {onOpenPage} {onPushed} {onWriteNewPage} />
</Dialog>
