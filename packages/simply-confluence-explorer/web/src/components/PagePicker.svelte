<script lang="ts">
  import { ArrowLeft, Check, ChevronDown, ChevronRight, Search, Tag, X } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { PageTreeNode, TaggedPages } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { count, marks, titleLeftOut, toggle, type Choice, type Mark } from '../support/choice.js';
  import { catalogProgress, readTags } from '../support/pageResult.js';
  import { collapsedFor, visibleRows, withChildren } from '../support/tree.js';
  import Segmented from './ui/Segmented.svelte';

  // Choosing a Space chat's pages over the whole window (design doc 0016): the space's tree with a box
  // for each page, its tags, and words that leave out matching titles. Done saves the choice; Cancel,
  // or Esc, goes back to the chat without changing it.
  type Props = {
    spaceKey: string;
    tree: PageTreeNode[];
    initial: Choice;
    onDone: (choice: Choice) => void;
    onCancel: () => void;
  };

  let { spaceKey, tree, initial, onDone, onCancel }: Props = $props();
  let choice = $state<Choice>(untrack(() => structuredClone($state.snapshot(initial))));
  let tab = $state<'pages' | 'tags'>('pages');
  let query = $state('');
  let rule = $state('');
  let collapsed = $state(untrack(() => collapsedFor(tree, null)));
  let tags = $state<TaggedPages[] | null>(null);
  let tagsBuilding = $state<{ done: number; total: number } | null>(null);

  $effect(() =>
    readTags(
      () => api.tags(spaceKey),
      (t) => {
        tags = t;
        tagsBuilding = null;
      },
      (b) => (tagsBuilding = b),
      () => (tags = []), // An unsynced space has no tags; its pages can still be ticked.
    ),
  );
  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const tagged = $derived(
    new Set((tags ?? []).filter((t) => choice.tags.includes(t.tag)).flatMap((t) => t.pages.map((p) => p.id))),
  );
  const all = $derived(marks(tree, choice, tagged));
  const totals = $derived(count(all));
  // While searching, every match shows with the way down to it.
  const rows = $derived(visibleRows(tree, query.trim() ? new Set() : collapsed, query));
  const markOf = (id: string): Mark => all.get(id) ?? { own: 'none', mixed: false, chosen: false };
  const pagesUnder = (n: PageTreeNode): number => n.children.reduce((s, c) => s + 1 + pagesUnder(c), 0);

  function tick(node: PageTreeNode, on: boolean): void {
    choice = toggle(choice, node, on, (next) => marks(tree, next, tagged).get(node.id)?.own ?? 'none');
  }
  function fold(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }
  function addRule(): void {
    const words = rule.trim();
    if (words && !choice.leaveOutTitles.includes(words)) choice.leaveOutTitles = [...choice.leaveOutTitles, words];
    rule = '';
  }
  function toggleTag(tag: string): void {
    choice.tags = choice.tags.includes(tag) ? choice.tags.filter((t) => t !== tag) : [...choice.tags, tag];
  }
  const why = (node: PageTreeNode, m: Mark): string => {
    if (m.own === 'rule') return `left out: ${choice.leaveOutTitles.find((r) => titleLeftOut(node.title, [r]))}`;
    if (m.own === 'left') return choice.leftOut.includes(node.id) ? 'left out' : 'left out with a page above';
    return '';
  };
</script>

<div class="review-flow" role="dialog" aria-modal="true" aria-label="Pages for this chat">
  <header class="review-flow-bar">
    <button class="btn btn-secondary review-exit" onclick={onCancel} title="Back to the chat without changing it (Esc)">
      <ArrowLeft size={15} /> Cancel
    </button>
    <div class="review-flow-title">
      <strong>Pages for this chat</strong>
      <span class="muted">
        {totals.read
          ? `${totals.read} page${totals.read === 1 ? '' : 's'}${totals.leftOut ? ` · ${totals.leftOut} left out` : ''}`
          : 'Nothing ticked: the chat reads the whole space'}
      </span>
    </div>
    <span class="spacer"></span>
    <button class="btn btn-primary" onclick={() => onDone(choice)}><Check size={15} /> Done</button>
  </header>

  <div class="page-picker-tools">
    <Segmented
      label="Choose by"
      value={tab}
      onChange={(v) => (tab = v)}
      options={[
        { value: 'pages', label: 'Pages' },
        { value: 'tags', label: 'Tags', title: 'Every page with a tag' },
      ]}
    />
    <div class="search-field">
      <Search size={13} />
      <input
        class="form-input input-sm"
        placeholder={tab === 'pages' ? 'Find pages by title' : 'Filter tags'}
        aria-label={tab === 'pages' ? 'Find pages by title' : 'Filter tags'}
        bind:value={query}
      />
    </div>
    {#if tab === 'pages'}
      <button class="btn btn-secondary btn-sm" onclick={() => (collapsed = new Set())}>Expand all</button>
      <button class="btn btn-secondary btn-sm" onclick={() => (collapsed = withChildren(tree))}>Collapse all</button>
    {/if}
    <form
      class="page-picker-rule"
      onsubmit={(e) => {
        e.preventDefault();
        addRule();
      }}
    >
      <input
        class="form-input input-sm"
        placeholder="Leave out titles containing…"
        aria-label="Leave out titles containing"
        bind:value={rule}
      />
      <button class="btn btn-secondary btn-sm" disabled={!rule.trim()}>Leave out</button>
    </form>
    {#each choice.leaveOutTitles as r (r)}
      <span class="scope-chip">
        Not: “{r}”
        <button
          type="button"
          class="scope-chip-remove"
          aria-label="Stop leaving out titles with {r}"
          onclick={() => (choice.leaveOutTitles = choice.leaveOutTitles.filter((x) => x !== r))}><X size={12} /></button
        >
      </span>
    {/each}
  </div>

  <div class="page-picker-body">
    {#if tab === 'pages'}
      <ul class="page-picker-tree" role="tree" aria-label="Pages of {spaceKey}">
        {#each rows as row (row.node.id)}
          {@const m = markOf(row.node.id)}
          {@const locked = m.own === 'rule' || (m.own === 'left' && !choice.leftOut.includes(row.node.id))}
          {@const out = m.chosen && m.own !== 'in'}
          <li
            role="treeitem"
            aria-selected={m.own === 'in'}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            class={['page-picker-row', out && 'page-picker-out']}
            style="padding-left: {8 + row.depth * 20}px"
          >
            {#if row.hasChildren && !query.trim()}
              <button
                type="button"
                class="icon-btn"
                aria-label={row.expanded ? 'Fold' : 'Unfold'}
                onclick={() => fold(row.node.id)}
              >
                {#if row.expanded}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
              </button>
            {:else}
              <span class="page-picker-gap"></span>
            {/if}
            <label>
              <input
                type="checkbox"
                checked={m.own === 'in'}
                disabled={locked}
                {@attach (el: HTMLInputElement) => {
                  el.indeterminate = m.mixed;
                }}
                onchange={(e) => tick(row.node, e.currentTarget.checked)}
              />
              {row.node.title}
            </label>
            {#if row.hasChildren}<span class="muted">· {pagesUnder(row.node)} under it</span>{/if}
            {#if why(row.node, m)}<span class="muted page-picker-why">{why(row.node, m)}</span>{/if}
          </li>
        {:else}
          <li class="muted">
            {query.trim() ? 'No page has that in its title.' : 'This space has no pages to choose.'}
          </li>
        {/each}
      </ul>
    {:else}
      <div class="chip-row">
        {#each (tags ?? []).filter((t) => t.tag.includes(query.trim().toLowerCase())) as t (t.tag)}
          <button
            type="button"
            class={['pill', 'chat-context-tag', choice.tags.includes(t.tag) && 'active']}
            aria-pressed={choice.tags.includes(t.tag)}
            onclick={() => toggleTag(t.tag)}
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
