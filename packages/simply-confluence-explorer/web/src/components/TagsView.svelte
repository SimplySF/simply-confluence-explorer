<script lang="ts">
  import { ArrowLeft, FileText, MessagesSquare, Search, Tag } from '@lucide/svelte';
  import type { TaggedPages } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { messageOf } from '../support/toast.svelte.js';

  // The pages of a space grouped by tag, so pages about one subject can be found and reviewed
  // together wherever they sit in the tree (ADR-046). Excluded pages are never listed.
  type Props = {
    spaceKey: string;
    synced: boolean;
    selectedPageId: string | null;
    onSelectPage: (pageId: string) => void;
    onAsk: (tag: TaggedPages) => void;
  };

  let { spaceKey, synced, selectedPageId, onSelectPage, onAsk }: Props = $props();
  let tags = $state<TaggedPages[]>([]);
  let filter = $state('');
  let chosen = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loaded = $state(0);

  // Read again after a sync or a summary run, which can add pages and tags.
  $effect(() => jobs.onFinished((j) => j.spaceKey === spaceKey && loaded++));

  // Another space starts at its list of tags.
  $effect(() => {
    void spaceKey;
    chosen = null;
  });

  $effect(() => {
    void loaded;
    const key = spaceKey;
    error = null;
    if (!synced) {
      tags = [];
      return;
    }
    api.tags(key).then(
      (t) => (tags = t),
      (e: unknown) => (error = messageOf(e)),
    );
  });

  const shown = $derived(tags.filter((t) => t.tag.includes(filter.trim().toLowerCase())));
  const current = $derived(tags.find((t) => t.tag === chosen) ?? null);
</script>

<div class="tags-view">
  {#if !synced}
    <p class="muted tree-message">Sync the space to see its pages by tag.</p>
  {:else if error}
    <p class="alert alert-error">{error}</p>
  {:else if current}
    <div class="tags-head">
      <button type="button" class="btn btn-secondary btn-sm" onclick={() => (chosen = null)} title="All tags">
        <ArrowLeft size={13} />
      </button>
      <strong class="tags-title"><Tag size={13} /> {current.tag}</strong>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        onclick={() => onAsk(current)}
        title="Open a chat that reads these pages"
      >
        <MessagesSquare size={13} /> Chat about {current.pages.length}
      </button>
    </div>
    <ul class="tags-pages">
      {#each current.pages as p (p.id)}
        <li>
          <button
            type="button"
            class={['tags-page', p.id === selectedPageId && 'selected']}
            onclick={() => onSelectPage(p.id)}
            title={p.summary ?? p.title}
          >
            <span class="tags-page-title"><FileText size={13} /> {p.title}</span>
            {#if p.path}<span class="tags-page-path">{p.path}</span>{/if}
            {#if p.summary}<span class="tags-page-summary">{p.summary}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="search-field">
      <Search size={13} />
      <input class="form-input input-sm" placeholder="Filter tags" aria-label="Filter tags" bind:value={filter} />
    </div>
    {#if tags.length === 0}
      <p class="muted tree-message">
        No tags yet. Pages get tags from their Confluence labels and from AI summaries (Space menu).
      </p>
    {/if}
    <ul class="tags-list">
      {#each shown as t (t.tag)}
        <li>
          <button type="button" class="tags-item" onclick={() => (chosen = t.tag)}>
            <span><Tag size={12} /> {t.tag}</span>
            <span class="tags-count">{t.pages.length}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
