<script lang="ts">
  import { FileText, Folder, Globe, Plus, Search, Tag, X } from '@lucide/svelte';
  import type { SessionScope, TaggedPages } from '../../../src/api/types.js';
  import { api, type Coverage } from '../support/api.js';
  import type { AiChat } from '../support/chat.svelte.js';
  import { catalogProgress, readTags } from '../support/pageResult.js';
  import { directoryLabel, readingLine, searchPages, type SpacePage } from '../support/pages.js';
  import SummaryCoverage from './SummaryCoverage.svelte';
  import Segmented from './ui/Segmented.svelte';

  // What a Space chat reads, as one row above it: a chip for each directory (with every page under it),
  // page and tag the person chose, in any mix, or the whole space when nothing is chosen (ADR-051).
  // There is no limit on how many; the count says how many are indexed, and its hint whether each
  // question reads them all or finds the sections it needs in them. Pages and tags are added from a
  // popover under the row.
  type Choice = { kind: 'space' } | { kind: 'pages'; dirs: string[]; pageIds: string[]; tags: string[] };
  type Props = {
    spaceKey: string;
    scope: SessionScope;
    /** The space's pages, to find by title; excluded pages are never among them. */
    pages: SpacePage[];
    /** Saves a new choice; the row shows it at once, marked as saving, until this settles. */
    onChange: (choice: Choice) => Promise<void>;
    onSelectPage: (pageId: string) => void;
    /** The chat, which keeps its choice about its pages' attachments. */
    chat?: AiChat;
    /** What the chosen pages hold, shared with the chat's notes on their attachments. */
    counts?: Coverage | null;
    /** The chosen pages are being checked, so the chat waits and says so. */
    checking?: boolean;
  };

  let {
    spaceKey,
    scope,
    pages,
    onChange,
    onSelectPage,
    chat,
    counts = $bindable(null),
    checking = $bindable(false),
  }: Props = $props();
  let addOpen = $state(false);
  let addTab = $state<'pages' | 'tags'>('pages');
  // Unread until the popover first offers them, so "no tags" is not said while they are being read.
  let tags = $state<TaggedPages[] | null>(null);
  let tagsBuilding = $state<{ done: number; total: number } | null>(null);
  let query = $state('');
  let box: HTMLDivElement;
  let find = $state<HTMLInputElement>();

  $effect(() => {
    if (!addOpen || tags) return;
    return readTags(
      () => api.tags(spaceKey),
      (t) => {
        tags = t;
        tagsBuilding = null;
      },
      (b) => (tagsBuilding = b),
      () => (tags = []), // An unsynced space has no tags; choosing pages by title still works.
    );
  });

  $effect(() => {
    if (!addOpen) return;
    find?.focus();
    const outside = (e: MouseEvent): void => {
      if (!box.contains(e.target as Node)) addOpen = false;
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  });

  // A choice being saved is shown at once, so a chip appears as soon as a page is added; the saved scope
  // takes over when the save settles, and a failed save leaves the row as it was.
  // Raw, so the choice compared when its save settles is the one that was made, not a proxy of it.
  let saving = $state.raw<Choice | null>(null);
  const shown = $derived<Choice | SessionScope>(saving ?? scope);
  const dirs = $derived(shown.kind === 'pages' ? (shown.dirs ?? []) : []);
  const singles = $derived(shown.kind === 'pages' ? (shown.pageIds ?? []) : []);
  const chosenTags = $derived(shown.kind === 'pages' ? (shown.tags ?? []) : []);
  const byId = $derived(new Map(pages.map((p) => [p.id, p])));
  const pageOf = (id: string): SpacePage => byId.get(id) ?? { id, title: id, path: '', under: [] };
  const tagSize = (tag: string): number | undefined => tags?.find((t) => t.tag === tag)?.pages.length;
  const results = $derived(searchPages(pages, query));
  const shownTags = $derived((tags ?? []).filter((t) => t.tag.includes(query.trim().toLowerCase())));
  const chosen = $derived(scope.kind === 'pages' ? { dirs, pageIds: singles, tags: chosenTags } : undefined);

  function choose(next: { dirs?: string[]; pageIds?: string[]; tags?: string[] }): void {
    const choice = {
      kind: 'pages' as const,
      dirs: [...new Set(next.dirs ?? dirs)],
      pageIds: [...new Set(next.pageIds ?? singles)],
      tags: [...new Set(next.tags ?? chosenTags)],
    };
    const made: Choice =
      choice.dirs.length + choice.pageIds.length + choice.tags.length === 0 ? { kind: 'space' } : choice;
    saving = made;
    void onChange(made).finally(() => {
      if (saving === made) saving = null;
    });
  }

  function added(): void {
    addOpen = false;
    query = '';
  }
  // A directory added after one of its pages takes that page's place, so the row names it once.
  function addDirectory(p: SpacePage): void {
    choose({ dirs: [...dirs, p.id], pageIds: singles.filter((id) => id !== p.id) });
    added();
  }
  function addPage(p: SpacePage): void {
    choose({ pageIds: [...singles, p.id] });
    added();
  }
  function addTag(tag: string): void {
    if (!chosenTags.includes(tag)) choose({ tags: [...chosenTags, tag] });
    added();
  }
</script>

<div class="scope-bar chat-context" bind:this={box}>
  <span>Reading</span>
  {#each dirs as id (id)}
    <span class="scope-chip">
      <Folder size={12} />
      <button type="button" class="scope-chip-name" onclick={() => onSelectPage(id)} title="Open {pageOf(id).title}"
        >{directoryLabel(pageOf(id))}</button
      >
      <button
        type="button"
        class="scope-chip-remove"
        aria-label="Remove {pageOf(id).title} and its sub-pages"
        onclick={() => choose({ dirs: dirs.filter((d) => d !== id) })}><X size={12} /></button
      >
    </span>
  {/each}
  {#each singles as id (id)}
    <span class="scope-chip">
      <FileText size={12} />
      <button type="button" class="scope-chip-name" onclick={() => onSelectPage(id)} title="Open {pageOf(id).title}"
        >{pageOf(id).title}</button
      >
      <button
        type="button"
        class="scope-chip-remove"
        aria-label="Remove {pageOf(id).title}"
        onclick={() => choose({ pageIds: singles.filter((p) => p !== id) })}><X size={12} /></button
      >
    </span>
  {/each}
  {#each chosenTags as t (t)}
    <span class="scope-chip">
      <Tag size={12} />
      <span class="scope-chip-name">#{t}{tagSize(t) === undefined ? '' : ` · ${tagSize(t)}`}</span>
      <button
        type="button"
        class="scope-chip-remove"
        aria-label="Remove #{t}"
        onclick={() => choose({ tags: chosenTags.filter((x) => x !== t) })}><X size={12} /></button
      >
    </span>
  {/each}
  {#if saving}
    <span class="scope-saving" role="status"><span class="spinner" aria-hidden="true"></span> Saving…</span>
  {/if}
  {#if shown.kind !== 'pages'}
    <span class="scope-chip scope-chip-plain" title="Each question searches the whole space for the sections it needs">
      <Globe size={12} /> Whole space{pages.length ? ` · ${pages.length} pages` : ''}
    </span>
  {/if}
  <button
    type="button"
    class="scope-chip scope-chip-add"
    aria-expanded={addOpen}
    onclick={() => (addOpen = !addOpen)}
    title="Read only the directories, pages and tags you add; with none, the chat reads the whole space"
  >
    <Plus size={12} /> Add pages or tags
  </button>
  <span class="spacer"></span>
  <span title={counts ? readingLine(counts) : undefined}>
    <SummaryCoverage {spaceKey} {chosen} bind:counts bind:checking {chat} />
  </span>

  {#if addOpen}
    <div
      class="scope-popover"
      role="dialog"
      aria-label="Add pages or tags"
      tabindex="-1"
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          addOpen = false;
        }
      }}
    >
      <div class="search-field">
        <Search size={13} />
        <input
          class="form-input input-sm"
          placeholder={addTab === 'pages' ? 'Find a page or directory by title' : 'Filter tags'}
          aria-label={addTab === 'pages' ? 'Find a page or directory' : 'Filter tags'}
          autocomplete="off"
          bind:this={find}
          bind:value={query}
        />
      </div>
      <Segmented
        label="Add"
        quiet
        value={addTab}
        onChange={(v) => (addTab = v)}
        options={[
          { value: 'pages', label: 'Pages' },
          { value: 'tags', label: 'Tags', title: 'Every page with a tag' },
        ]}
      />
      <div class="scope-popover-list">
        {#if addTab === 'pages'}
          {#each results as p (p.id)}
            <div class="scope-result">
              {#if p.under.length}<Folder size={14} />{:else}<FileText size={14} />{/if}
              <div class="scope-result-name">
                <strong>{p.title}</strong>
                <span>{p.path || 'Top level'}</span>
              </div>
              {#if dirs.includes(p.id)}
                <span class="muted">Added with its sub-pages</span>
              {:else}
                {#if singles.includes(p.id)}
                  <span class="muted">Added</span>
                {:else}
                  <button type="button" class="btn btn-secondary btn-xs" onclick={() => addPage(p)}>Page</button>
                {/if}
                {#if p.under.length}
                  <button type="button" class="btn btn-primary btn-xs" onclick={() => addDirectory(p)}>
                    + {p.under.length} sub-page{p.under.length === 1 ? '' : 's'}
                  </button>
                {/if}
              {/if}
            </div>
          {:else}
            <p class="muted">{query.trim() ? 'No page has that in its title.' : 'Start typing a title.'}</p>
          {/each}
        {:else}
          <div class="chip-row">
            {#each shownTags as t (t.tag)}
              <button
                type="button"
                class={['pill', 'chat-context-tag', chosenTags.includes(t.tag) && 'active']}
                aria-pressed={chosenTags.includes(t.tag)}
                onclick={() => addTag(t.tag)}
              >
                <Tag size={11} />
                {t.tag} <span class="muted">{t.pages.length}</span>
              </button>
            {:else}
              <span class="muted"
                >{tags === null
                  ? tagsBuilding
                    ? `${catalogProgress(spaceKey, tagsBuilding)}…`
                    : 'Reading tags…'
                  : tags.length
                    ? 'No tag matches.'
                    : 'Sync the space to choose pages by tag.'}</span
              >
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
