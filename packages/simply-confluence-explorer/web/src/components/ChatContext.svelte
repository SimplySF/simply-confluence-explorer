<script lang="ts">
  import { BookOpen, ChevronDown, ChevronUp, FileText, Folder, Plus, Search, Tag, X } from '@lucide/svelte';
  import type { SessionScope, TaggedPages } from '../../../src/api/types.js';
  import { api, type Coverage } from '../support/api.js';
  import { directoryLabel, readingLine, searchPages, type SpacePage } from '../support/pages.js';
  import SummaryCoverage from './SummaryCoverage.svelte';
  import Segmented from './ui/Segmented.svelte';

  // What a Space chat reads, shown above it and changed in place: the whole space, or pages the person
  // chose as directories (each with every page under it), single pages and tags, in any mix (ADR-051).
  // There is no limit on how many: a line says whether each question reads them all or finds the
  // sections it needs in them.
  type Choice = { kind: 'space' } | { kind: 'pages'; dirs: string[]; pageIds: string[]; tags: string[] };
  type Props = {
    spaceKey: string;
    scope: SessionScope;
    /** The space's pages, to find by title; excluded pages are never among them. */
    pages: SpacePage[];
    onChange: (choice: Choice) => void;
    onSelectPage: (pageId: string) => void;
  };

  let { spaceKey, scope, pages, onChange, onSelectPage }: Props = $props();
  /** How many tags are shown before "Show all", so a space with hundreds stays readable. */
  const TAGS_SHOWN = 24;
  let open = $state(false);
  let tags = $state<TaggedPages[]>([]);
  let allTags = $state(false);
  let query = $state('');
  let counts = $state<Coverage | null>(null);
  // The mode the person picked. Choosing pages starts with none chosen, and until one is, the chat
  // still reads the whole space, so the mode is kept here as well as in the chat's scope.
  let mode = $state<'space' | 'pages'>('space');
  $effect(() => {
    if (scope.kind === 'pages') mode = 'pages';
  });

  function pickMode(next: 'space' | 'pages'): void {
    mode = next;
    if (next === 'space' && scope.kind === 'pages') onChange({ kind: 'space' });
  }

  $effect(() => {
    if (!open || mode !== 'pages' || tags.length) return;
    api.tags(spaceKey).then(
      (t) => (tags = t),
      () => (tags = []), // An unsynced space has no tags; choosing pages by title still works.
    );
  });

  const dirs = $derived(scope.kind === 'pages' ? (scope.dirs ?? []) : []);
  const singles = $derived(scope.kind === 'pages' ? (scope.pageIds ?? []) : []);
  const chosenTags = $derived(scope.kind === 'pages' ? (scope.tags ?? []) : []);
  const byId = $derived(new Map(pages.map((p) => [p.id, p])));
  const pageOf = (id: string): SpacePage => byId.get(id) ?? { id, title: id, path: '', under: [] };
  const tagSize = (tag: string): number | undefined => tags.find((t) => t.tag === tag)?.pages.length;
  const results = $derived(searchPages(pages, query));
  const shownTags = $derived(allTags ? tags : tags.slice(0, TAGS_SHOWN));
  const chosen = $derived(scope.kind === 'pages' ? { dirs, pageIds: singles, tags: chosenTags } : undefined);

  const names = $derived([
    ...dirs.map((id) => `${pageOf(id).title} + sub-pages`),
    ...singles.map((id) => pageOf(id).title),
    ...chosenTags.map((t) => `#${t}`),
  ]);
  const label = $derived(
    scope.kind === 'pages'
      ? names.length > 3
        ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
        : names.join(', ')
      : mode === 'pages'
        ? 'no pages chosen yet, so the whole space'
        : 'the whole space',
  );

  function choose(next: { dirs?: string[]; pageIds?: string[]; tags?: string[] }): void {
    const choice = {
      kind: 'pages' as const,
      dirs: [...new Set(next.dirs ?? dirs)],
      pageIds: [...new Set(next.pageIds ?? singles)],
      tags: [...new Set(next.tags ?? chosenTags)],
    };
    if (choice.dirs.length + choice.pageIds.length + choice.tags.length === 0) onChange({ kind: 'space' });
    else onChange(choice);
  }

  // A directory added after one of its pages takes that page's place, so the list names it once.
  const addDirectory = (p: SpacePage): void =>
    choose({ dirs: [...dirs, p.id], pageIds: singles.filter((id) => id !== p.id) });
  const addPage = (p: SpacePage): void => choose({ pageIds: [...singles, p.id] });
  let find = $state<HTMLInputElement>();
  function clearSearch(): void {
    query = '';
    find?.focus();
  }

  const toggleTag = (tag: string): void =>
    choose({ tags: chosenTags.includes(tag) ? chosenTags.filter((t) => t !== tag) : [...chosenTags, tag] });
</script>

<div class="chat-context">
  <button type="button" class="chat-context-bar" onclick={() => (open = !open)} aria-expanded={open}>
    <BookOpen size={13} />
    <span>Reading: {label}</span>
    {#if open}<ChevronUp size={13} />{:else}<ChevronDown size={13} />{/if}
  </button>
  {#if counts}<p class="chat-context-line">{readingLine(counts)}</p>{/if}
  <div class="chat-context-coverage">
    <SummaryCoverage {spaceKey} {chosen} bind:counts />
  </div>
  {#if open}
    <div class="chat-context-panel">
      <Segmented
        label="What this chat reads"
        value={mode}
        onChange={pickMode}
        options={[
          { value: 'space', label: 'Whole space', title: 'Each question searches the whole space' },
          { value: 'pages', label: 'Chosen pages', title: 'Only the directories, pages and tags chosen below' },
        ]}
      />
      {#if mode === 'space'}
        <p class="muted">
          Each question searches the whole space for the sections it needs, and the answer says which it read and why.
          Choose <strong>Chosen pages</strong> to read only the directories, pages and tags you pick.
        </p>
      {:else}
        <div class="chat-context-section">
          <label class="muted" for="chat-context-find">Find a page or directory</label>
          <div class="search-field">
            <Search size={13} />
            <input
              id="chat-context-find"
              class="form-input input-sm"
              placeholder="Start typing a title"
              autocomplete="off"
              bind:this={find}
              bind:value={query}
              onkeydown={(e) => e.key === 'Escape' && clearSearch()}
            />
            {#if query}
              <button type="button" class="icon-btn" aria-label="Clear the search" title="Clear" onclick={clearSearch}>
                <X size={13} />
              </button>
            {/if}
          </div>
          {#if results.length}
            <ul class="chat-context-results">
              {#each results as p (p.id)}
                <li>
                  <div class="chat-context-result-name">
                    <strong>{p.title}</strong>
                    <span class="muted">{p.path || 'Top level'}</span>
                  </div>
                  {#if dirs.includes(p.id)}
                    <span class="muted">Added with its sub-pages</span>
                  {:else}
                    {#if singles.includes(p.id)}
                      <span class="muted">Added</span>
                    {:else}
                      <button type="button" class="btn btn-secondary btn-xs" onclick={() => addPage(p)}>
                        <Plus size={11} /> Add page
                      </button>
                    {/if}
                    {#if p.under.length}
                      <button type="button" class="btn btn-secondary btn-xs" onclick={() => addDirectory(p)}>
                        <Folder size={11} /> Add with {p.under.length} sub-page{p.under.length === 1 ? '' : 's'}
                      </button>
                    {/if}
                  {/if}
                </li>
              {/each}
            </ul>
          {:else if query.trim()}
            <span class="muted">No page has that in its title.</span>
          {/if}
        </div>
        <div class="chat-context-section">
          <span class="muted">Or add every page with a tag</span>
          <div class="chip-row">
            {#each shownTags as t (t.tag)}
              <button
                type="button"
                class={['pill', 'chat-context-tag', chosenTags.includes(t.tag) && 'active']}
                aria-pressed={chosenTags.includes(t.tag)}
                onclick={() => toggleTag(t.tag)}
              >
                <Tag size={11} />
                {t.tag} <span class="muted">{t.pages.length}</span>
              </button>
            {:else}
              <span class="muted">Sync the space to choose pages by tag.</span>
            {/each}
            {#if tags.length > TAGS_SHOWN}
              <button type="button" class="link-btn" onclick={() => (allTags = !allTags)}>
                {allTags ? 'Show fewer' : `Show all ${tags.length} tags`}
              </button>
            {/if}
          </div>
        </div>
        <div class="chat-context-section">
          <span class="muted">Chosen</span>
          {#if names.length}
            <ul class="chat-context-chosen">
              {#each dirs as id (id)}
                <li>
                  <Folder size={12} />
                  <button type="button" class="link-btn" onclick={() => onSelectPage(id)}>
                    {directoryLabel(pageOf(id))}
                  </button>
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label="Remove {pageOf(id).title} and its sub-pages"
                    onclick={() => choose({ dirs: dirs.filter((d) => d !== id) })}
                  >
                    <X size={11} />
                  </button>
                </li>
              {/each}
              {#each singles as id (id)}
                <li>
                  <FileText size={12} />
                  <button type="button" class="link-btn" onclick={() => onSelectPage(id)}>{pageOf(id).title}</button>
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label="Remove {pageOf(id).title}"
                    onclick={() => choose({ pageIds: singles.filter((p) => p !== id) })}
                  >
                    <X size={11} />
                  </button>
                </li>
              {/each}
              {#each chosenTags as t (t)}
                <li>
                  <Tag size={12} />
                  <span>#{t}{tagSize(t) === undefined ? '' : ` · ${tagSize(t)} pages`}</span>
                  <button type="button" class="icon-btn" aria-label="Remove #{t}" onclick={() => toggleTag(t)}>
                    <X size={11} />
                  </button>
                </li>
              {/each}
            </ul>
          {:else}
            <span class="muted">Nothing yet. Until you add something, the chat reads the whole space.</span>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
