<script lang="ts">
  import { ChevronDown, ChevronRight, FileText } from '@lucide/svelte';
  import type { SpaceTocNode } from '../../../src/api/types.js';
  import TocItem from './TocItem.svelte';

  type Props = {
    node: SpaceTocNode;
    depth: number;
    onSelectPage: (id: string) => void;
    selectedTag: string | null;
    filterText: string;
  };

  let { node, depth, onSelectPage, selectedTag, filterText }: Props = $props();
  let expanded = $state(true);
  const hasChildren = $derived(node.children.length > 0);
  const matches = $derived.by(() => {
    const q = filterText.toLowerCase();
    return (
      (!selectedTag || !!node.tags?.includes(selectedTag)) &&
      (!q || node.title.toLowerCase().includes(q) || !!node.summary?.toLowerCase().includes(q))
    );
  });
</script>

<div style:padding-left="{depth}rem">
  {#if matches}
    <div class="toc-item">
      <div class="toc-item-head">
        <button
          type="button"
          class="icon-btn"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          disabled={!hasChildren}
          onclick={() => (expanded = !expanded)}
        >
          {#if hasChildren}
            {#if expanded}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
          {/if}
        </button>
        <FileText size={14} class="tree-icon tree-icon-folder" />
        <button type="button" class="link-btn toc-title" onclick={() => onSelectPage(node.id)}>{node.title}</button>
        {#if node.documentType}<span class="pill pill-plain">{node.documentType}</span>{/if}
      </div>
      {#if node.summary}<p class="toc-summary">{node.summary}</p>{/if}
      {#if node.tags?.length}
        <div class="chip-row toc-tags">
          {#each node.tags as t (t)}<span class="pill">#{t}</span>{/each}
        </div>
      {/if}
    </div>
  {/if}
  {#if hasChildren && expanded}
    {#each node.children as child (child.id)}
      <TocItem node={child} depth={depth + 1} {onSelectPage} {selectedTag} {filterText} />
    {/each}
  {/if}
</div>
