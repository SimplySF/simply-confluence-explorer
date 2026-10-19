<script lang="ts">
  import { BookOpen, ChevronDown, ChevronUp, Tag, X } from '@lucide/svelte';
  import type { SessionScope, TaggedPages } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import Segmented from './ui/Segmented.svelte';

  // What a Space chat reads, shown above it and changed in place: the whole space, where each question
  // finds its own pages, or pages the person chose, by tag or by name (ADR-049).
  type Choice = { kind: 'space' } | { kind: 'pages'; pageIds: string[]; tags: string[] };
  type Props = {
    spaceKey: string;
    scope: SessionScope;
    /** The space's pages, to add by name; excluded pages are never among them. */
    pages: Array<{ id: string; title: string }>;
    onChange: (choice: Choice) => void;
    onSelectPage: (pageId: string) => void;
  };

  let { spaceKey, scope, pages, onChange, onSelectPage }: Props = $props();
  const MAX_PAGES = 50;
  let open = $state(false);
  let tags = $state<TaggedPages[]>([]);
  let query = $state('');

  $effect(() => {
    if (!open || tags.length) return;
    api.tags(spaceKey).then(
      (t) => (tags = t),
      () => (tags = []), // An unsynced space has no tags; choosing pages by name still works.
    );
  });

  const chosen = $derived(scope.kind === 'pages' ? (scope.pageIds ?? []) : []);
  const chosenTags = $derived(scope.kind === 'pages' ? (scope.tags ?? []) : []);
  const titleOf = (id: string): string => pages.find((p) => p.id === id)?.title ?? id;
  const label = $derived(
    scope.kind === 'pages'
      ? `${chosenTags.length ? chosenTags.map((t) => `#${t}`).join(', ') + ' · ' : ''}${chosen.length} chosen page${chosen.length === 1 ? '' : 's'}`
      : 'the whole space: each question finds its own pages',
  );

  const choose = (pageIds: string[], tagList: string[]): void =>
    pageIds.length
      ? onChange({ kind: 'pages', pageIds: [...new Set(pageIds)].slice(0, MAX_PAGES), tags: tagList })
      : onChange({ kind: 'space' });

  function toggleTag(t: TaggedPages): void {
    if (chosenTags.includes(t.tag)) {
      const rest = chosenTags.filter((x) => x !== t.tag);
      const keep = new Set(tags.filter((x) => rest.includes(x.tag)).flatMap((x) => x.pages.map((p) => p.id)));
      const theirs = new Set(t.pages.map((p) => p.id));
      choose(
        chosen.filter((id) => keep.has(id) || !theirs.has(id)),
        rest,
      );
    } else choose([...chosen, ...t.pages.map((p) => p.id)], [...chosenTags, t.tag]);
  }

  function addByName(): void {
    const page = pages.find((p) => p.title.toLowerCase() === query.trim().toLowerCase());
    if (!page) return;
    query = '';
    choose([...chosen, page.id], chosenTags);
  }
</script>

<div class="chat-context">
  <button type="button" class="chat-context-bar" onclick={() => (open = !open)} aria-expanded={open}>
    <BookOpen size={13} />
    <span>Reading: {label}</span>
    {#if open}<ChevronUp size={13} />{:else}<ChevronDown size={13} />{/if}
  </button>
  {#if open}
    <div class="chat-context-panel">
      <Segmented
        label="What this chat reads"
        value={scope.kind === 'pages' ? 'pages' : 'space'}
        onChange={(v) => v === 'space' && onChange({ kind: 'space' })}
        options={[
          { value: 'space', label: 'Whole space', title: 'Each question searches the space for the pages it needs' },
          { value: 'pages', label: 'Chosen pages', title: 'Only the pages chosen below, by tag or by name' },
        ]}
      />
      <div class="chat-context-section">
        <span class="muted">Choose by tag</span>
        <div class="chip-row">
          {#each tags as t (t.tag)}
            <button
              type="button"
              class={['pill', 'chat-context-tag', chosenTags.includes(t.tag) && 'active']}
              aria-pressed={chosenTags.includes(t.tag)}
              onclick={() => toggleTag(t)}
            >
              <Tag size={11} />
              {t.tag} <span class="muted">{t.pages.length}</span>
            </button>
          {:else}
            <span class="muted">Sync the space to choose pages by tag.</span>
          {/each}
        </div>
      </div>
      <form
        class="chat-context-section"
        onsubmit={(e) => {
          e.preventDefault();
          addByName();
        }}
      >
        <span class="muted">Add a page by name</span>
        <input
          class="form-input input-sm"
          list="chat-context-pages"
          placeholder="Start typing a page title"
          aria-label="Add a page by name"
          bind:value={query}
          onchange={addByName}
        />
        <datalist id="chat-context-pages">
          {#each pages as p (p.id)}<option value={p.title}></option>{/each}
        </datalist>
      </form>
      {#if chosen.length}
        <div class="chip-row">
          {#each chosen as id (id)}
            <span class="pill">
              <button type="button" class="link-btn" onclick={() => onSelectPage(id)}>{titleOf(id)}</button>
              <button
                type="button"
                class="icon-btn"
                aria-label="Remove {titleOf(id)}"
                onclick={() =>
                  choose(
                    chosen.filter((p) => p !== id),
                    chosenTags,
                  )}
              >
                <X size={11} />
              </button>
            </span>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
