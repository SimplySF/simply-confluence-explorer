<script lang="ts">
  import { RefreshCw, Search } from '@lucide/svelte';
  import type { SpaceTocNode } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import TocItem from './TocItem.svelte';

  // The space's site map with AI summaries and tags, built when the space is indexed.
  type Props = { spaceKey: string; onSelectPage: (pageId: string) => void };

  let { spaceKey, onSelectPage }: Props = $props();
  let nodes = $state<SpaceTocNode[]>([]);
  let loading = $state(false);
  let selectedTag = $state<string | null>(null);
  let filterText = $state('');

  async function load(): Promise<void> {
    loading = true;
    try {
      nodes = await api.toc(spaceKey);
    } catch {
      nodes = []; // Not generated yet: the empty state says how to build it.
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void spaceKey;
    void load();
  });

  const tags = $derived.by(() => {
    const all = new Set<string>();
    const collect = (list: SpaceTocNode[]): void => {
      for (const n of list) {
        n.tags?.forEach((t) => all.add(t));
        collect(n.children);
      }
    };
    collect(nodes);
    return [...all].slice(0, 15);
  });
</script>

<div class="toc-viewer">
  <div class="panel-bar">
    <div class="search-field">
      <Search size={13} />
      <input class="form-input input-sm" placeholder="Filter by title or summary" bind:value={filterText} />
    </div>
    <button type="button" class="btn btn-secondary btn-sm" onclick={load} title="Reload">
      <RefreshCw size={12} class={loading ? 'spin' : ''} />
    </button>
  </div>
  {#if tags.length > 0}
    <div class="chip-row">
      <span class="muted">Topic:</span>
      <button
        type="button"
        class={['pill', 'pill-toggle', !selectedTag && 'active']}
        onclick={() => (selectedTag = null)}
      >
        All
      </button>
      {#each tags as t (t)}
        <button
          type="button"
          class={['pill', 'pill-toggle', selectedTag === t && 'active']}
          onclick={() => (selectedTag = selectedTag === t ? null : t)}
        >
          #{t}
        </button>
      {/each}
    </div>
  {/if}
  {#if loading}
    <p class="muted tree-message">Loading the table of contents…</p>
  {:else if nodes.length === 0}
    <p class="muted tree-message">
      No table of contents yet. Choose <strong>Build the AI index</strong> in the Space menu to build it.
    </p>
  {:else}
    {#each nodes as n (n.id)}
      <TocItem node={n} depth={0} {onSelectPage} {selectedTag} {filterText} />
    {/each}
  {/if}
</div>
