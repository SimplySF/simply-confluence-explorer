<script lang="ts">
  import { RefreshCw, Search } from '@lucide/svelte';
  import { api } from '../support/api.js';
  import { looksLikeAddress, searchPages, type SpacePage } from '../support/pages.js';
  import { messageOf } from '../support/toast.svelte.js';

  // The one place to find a page: typing searches the open space's titles, and a pasted Confluence
  // address or page id is resolved by the server, which may open another space.
  type Props = {
    spaceKey: string;
    pages: SpacePage[];
    onOpenPage: (pageId: string) => void;
    onJump: (target: { spaceKey: string; pageId?: string }) => void;
  };

  let { spaceKey, pages, onOpenPage, onJump }: Props = $props();

  let query = $state('');
  let open = $state(false);
  let at = $state(0);
  let resolving = $state(false);
  let error = $state<string | null>(null);
  let box: HTMLDivElement;

  const address = $derived(looksLikeAddress(query));
  const hits = $derived(address ? [] : searchPages(pages, query));

  $effect(() => {
    if (!open) return;
    const outside = (e: MouseEvent): void => {
      if (!box.contains(e.target as Node)) open = false;
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  });

  function done(): void {
    query = '';
    open = false;
    error = null;
    (document.activeElement as HTMLElement | null)?.blur();
  }

  function choose(page: SpacePage): void {
    onOpenPage(page.id);
    done();
  }

  async function resolve(): Promise<void> {
    resolving = true;
    error = null;
    try {
      const res = await api.resolve(query.trim());
      if (res.spaceKey) {
        onJump({ spaceKey: res.spaceKey, pageId: res.pageId });
        done();
      } else error = 'No space found for this URL or id.';
    } catch (e) {
      error = messageOf(e);
    } finally {
      resolving = false;
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      done();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length) at = (at + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (address) void resolve();
      else if (hits[at]) choose(hits[at]);
    }
  }
</script>

<div class="header-search" bind:this={box}>
  <div class="header-search-field">
    {#if resolving}<RefreshCw size={15} class="spin" />{:else}<Search size={15} />{/if}
    <input
      id="page-search"
      type="text"
      autocomplete="off"
      placeholder={spaceKey
        ? `Find a page in ${spaceKey}, or paste a Confluence URL`
        : 'Paste a Confluence URL or page id'}
      aria-label="Find a page, or paste a Confluence URL or page id"
      role="combobox"
      aria-expanded={open && !!query.trim()}
      aria-controls="page-search-results"
      bind:value={query}
      oninput={() => {
        open = true;
        at = 0;
        error = null;
      }}
      onfocus={() => (open = true)}
      onkeydown={onKey}
      disabled={resolving}
    />
    <kbd class="header-search-key" title="Press / to search">/</kbd>
  </div>
  {#if open && query.trim()}
    <div class="header-search-results" id="page-search-results" role="listbox">
      {#if error}
        <div class="field-error">{error}</div>
      {:else if address}
        <div class="muted list-empty">Press Enter to open this page.</div>
      {:else if hits.length === 0}
        <div class="muted list-empty">No page in {spaceKey} has that in its title.</div>
      {:else}
        {#each hits as p, i (p.id)}
          <button
            type="button"
            role="option"
            aria-selected={i === at}
            class={['header-search-hit', i === at && 'active']}
            onmouseenter={() => (at = i)}
            onclick={() => choose(p)}
          >
            <span class="header-search-title">{p.title}</span>
            {#if p.path}<span class="header-search-path">{p.path}</span>{/if}
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>
