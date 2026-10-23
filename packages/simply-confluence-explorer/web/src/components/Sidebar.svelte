<script lang="ts">
  import {
    AlertTriangle,
    Check,
    ChevronDown,
    ChevronRight,
    ChevronsDownUp,
    ChevronsUpDown,
    CircleCheck,
    ListFilter,
    MessagesSquare,
    FileText,
    Upload,
    Folder,
    HardDrive,
    RefreshCw,
    Search,
    X,
  } from '@lucide/svelte';
  import type { ConfluenceSpace, PageTreeNode, SyncedSpace, TaggedPages } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { syncLine } from '../support/spaceStatus.js';
  import { ancestorsOf, collapsedFor } from '../support/tree.js';
  import { untrack } from 'svelte';
  import SpaceActions from './SpaceActions.svelte';
  import TagsView from './TagsView.svelte';
  import Segmented from './ui/Segmented.svelte';

  type Props = {
    spaces: ConfluenceSpace[];
    selectedSpace: string;
    onSelectSpace: (spaceKey: string) => void;
    tree: PageTreeNode[];
    selectedPageId: string | null;
    onSelectPage: (pageId: string) => void;
    loading: boolean;
    /** The list of Confluence's spaces is still on its way. */
    spacesLoading: boolean;
    error: string | null;
    /** The synced copy changed (a sync, a purge): reload the tree. */
    onTreeChanged: () => void;
    /** Ask about the pages that carry a tag, in Space chat. */
    onAskTag: (tag: TaggedPages) => void;
    chatOpen: boolean;
    onOpenChat: () => void;
    /** How many staged pages wait to be pushed across the space's chats. */
    pushCount: number;
    pushOpen: boolean;
    onOpenPush: () => void;
  };

  let {
    spaces,
    selectedSpace,
    onSelectSpace,
    tree,
    selectedPageId,
    onSelectPage,
    loading,
    spacesLoading,
    error,
    onTreeChanged,
    onAskTag,
    chatOpen,
    onOpenChat,
    pushCount,
    pushOpen,
    onOpenPush,
  }: Props = $props();

  type Row = { node: PageTreeNode; depth: number; parentId: string | null; hasChildren: boolean; expanded: boolean };

  /** The pages to show, in order: a collapsed page hides its children, and a filter keeps a page if it or a page under it matches. */
  function visibleRows(nodes: PageTreeNode[], collapsed: Set<string>, filter: string): Row[] {
    const q = filter.trim().toLowerCase();
    const matches = (n: PageTreeNode): boolean => !q || n.title.toLowerCase().includes(q) || n.children.some(matches);
    const rows: Row[] = [];
    const walk = (list: PageTreeNode[], depth: number, parentId: string | null): void => {
      for (const node of list) {
        if (!matches(node)) continue;
        const hasChildren = node.children.length > 0;
        const expanded = hasChildren && !collapsed.has(node.id);
        rows.push({ node, depth, parentId, hasChildren, expanded });
        if (expanded) walk(node.children, depth + 1, node.id);
      }
    };
    walk(nodes, 0, null);
    return rows;
  }

  const withChildren = (nodes: PageTreeNode[], into = new Set<string>()): Set<string> => {
    for (const n of nodes) {
      if (n.children.length) {
        into.add(n.id);
        withChildren(n.children, into);
      }
    }
    return into;
  };

  let switcherOpen = $state(false);
  let spaceFilter = $state('');
  let pageFilter = $state('');
  let collapsed = $state(new Set<string>());
  let view = $state<'pages' | 'tags'>('pages');
  let focusId = $state<string | null>(null);
  let saved = $state<SyncedSpace[]>([]);
  let switcher: HTMLDivElement;
  let spaceSearch = $state<HTMLInputElement>();

  function loadSaved(): void {
    // Without the list, the switcher still offers every Confluence space; only the "synced" marks are missing.
    api.synced().then(
      (s) => (saved = s),
      () => (saved = []),
    );
  }
  $effect(() => {
    void selectedSpace;
    loadSaved();
  });

  $effect(() => {
    if (!switcherOpen) return;
    spaceSearch?.focus();
    const outside = (e: MouseEvent): void => {
      if (!switcher.contains(e.target as Node)) switcherOpen = false;
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  });

  // A space's tree starts collapsed when it first loads; a reload of the same space, after a sync,
  // keeps what the person opened.
  let foldedFor = '';
  $effect(() => {
    const t = tree;
    // The tree names its own space, so the old space's tree, still shown while the new one loads, is not the one folded.
    const space = (t[0]?.spaceKey ?? '').toUpperCase();
    if (!space || foldedFor === space) return;
    foldedFor = space;
    collapsed = collapsedFor(
      t,
      untrack(() => selectedPageId),
    );
  });

  // A page opened from elsewhere, such as the header or a finding, is shown by opening the way to it.
  $effect(() => {
    const above = ancestorsOf(tree, selectedPageId);
    const shut = untrack(() => collapsed);
    if (above.some((id) => shut.has(id))) collapsed = new Set([...shut].filter((id) => !above.includes(id)));
  });

  const rows = $derived(visibleRows(tree, collapsed, pageFilter));

  $effect(() => {
    if (focusId) document.getElementById(`tree-${focusId}`)?.scrollIntoView({ block: 'nearest' });
  });

  function chooseSpace(key: string): void {
    onSelectSpace(key);
    switcherOpen = false;
    spaceFilter = '';
  }

  function toggle(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }

  function onTreeKey(e: KeyboardEvent): void {
    if (!rows.length) return;
    const at = Math.max(
      0,
      rows.findIndex((r) => r.node.id === focusId),
    );
    const row = rows[at];
    const moveTo = (i: number): void => {
      focusId = rows[Math.max(0, Math.min(rows.length - 1, i))].node.id;
    };
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveTo(at + 1),
      ArrowUp: () => moveTo(at - 1),
      Home: () => moveTo(0),
      End: () => moveTo(rows.length - 1),
      ArrowRight: () => (row.hasChildren && !row.expanded ? toggle(row.node.id) : row.expanded && moveTo(at + 1)),
      ArrowLeft: () => (row.expanded ? toggle(row.node.id) : row.parentId && (focusId = row.parentId)),
      Enter: () => onSelectPage(row.node.id),
      ' ': () => onSelectPage(row.node.id),
    };
    if (!keys[e.key]) return;
    keys[e.key]();
    e.preventDefault();
  }

  const upper = $derived(selectedSpace.toUpperCase());
  const active = $derived(spaces.find((s) => s.key.toUpperCase() === upper));
  const savedKeys = $derived(new Set(saved.map((s) => s.spaceKey.toUpperCase())));
  const hit = (key: string, name: string): boolean => {
    const q = spaceFilter.trim().toLowerCase();
    return !q || key.toLowerCase().includes(q) || name.toLowerCase().includes(q);
  };
  const savedShown = $derived(saved.filter((s) => hit(s.spaceKey, s.name)));
  const othersShown = $derived(spaces.filter((s) => !savedKeys.has(s.key.toUpperCase()) && hit(s.key, s.name)));
  const manifest = $derived(saved.find((s) => s.spaceKey.toUpperCase() === upper));
</script>

<div class="sidebar-panel">
  <div class="sidebar-header">
    <div
      class="space-switcher"
      bind:this={switcher}
      role="presentation"
      onkeydown={(e) => {
        if (e.key === 'Escape' && switcherOpen) {
          e.stopPropagation();
          switcherOpen = false;
        }
      }}
    >
      <button
        type="button"
        class="space-switcher-button"
        aria-haspopup="listbox"
        aria-expanded={switcherOpen}
        onclick={() => (switcherOpen = !switcherOpen)}
      >
        <span class={['space-key', savedKeys.has(upper) && 'space-key-synced']}>{selectedSpace || '—'}</span>
        <span class="space-switcher-text">
          <span class="space-name">{active?.name || manifest?.name || selectedSpace || 'Choose a space'}</span>
          {#if selectedSpace}
            <span
              class="space-switcher-status"
              title={manifest
                ? `Synced ${new Date(manifest.lastSynced).toLocaleString()}`
                : 'Read live from Confluence'}
            >
              {#if manifest}<CircleCheck size={12} />{:else}<HardDrive size={12} />{/if}
              {syncLine(manifest)}
            </span>
          {/if}
        </span>
        <ChevronsUpDown size={14} />
      </button>
      {#if switcherOpen}
        <div class="space-switcher-list">
          <div class="search-field">
            <Search size={13} />
            <input
              bind:this={spaceSearch}
              class="form-input input-sm"
              placeholder="Search spaces"
              bind:value={spaceFilter}
            />
            {#if spaceFilter}
              <button type="button" class="icon-btn" onclick={() => (spaceFilter = '')} aria-label="Clear"
                ><X size={13} /></button
              >
            {/if}
          </div>
          <div class="space-switcher-scroll" role="listbox">
            {#if spacesLoading}
              <div class="muted list-heading"><RefreshCw size={11} class="spin" /> Loading Confluence's spaces…</div>
            {/if}
            {#if savedShown.length > 0}
              <div class="list-heading"><HardDrive size={11} /> Synced to this machine</div>
            {/if}
            {#each savedShown as s (s.spaceKey)}
              <button
                type="button"
                role="option"
                aria-selected={s.spaceKey.toUpperCase() === upper}
                class="space-option"
                onclick={() => chooseSpace(s.spaceKey)}
              >
                <span class="space-key space-key-synced">{s.spaceKey}</span>
                <span class="space-name">{s.name || s.spaceKey}</span>
                <span class="muted">{s.pageCount} pages</span>
                {#if s.spaceKey.toUpperCase() === upper}<Check size={13} />{/if}
              </button>
            {/each}
            <div class="list-heading">In Confluence</div>
            {#if othersShown.length === 0}<div class="muted list-empty">No other spaces match.</div>{/if}
            {#each othersShown as s (s.key)}
              <button
                type="button"
                role="option"
                aria-selected={s.key.toUpperCase() === upper}
                class="space-option"
                onclick={() => chooseSpace(s.key)}
              >
                <span class="space-key">{s.key}</span>
                <span class="space-name">{s.name}</span>
                {#if s.key.toUpperCase() === upper}<Check size={13} />{/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    {#if selectedSpace}
      <SpaceActions
        spaceKey={selectedSpace}
        {manifest}
        {onSelectPage}
        onChanged={() => {
          loadSaved();
          onTreeChanged();
        }}
      />
    {/if}

    <nav class="sidebar-nav" aria-label="Space views">
      <button
        type="button"
        class={['sidebar-nav-item', chatOpen && 'active']}
        aria-current={chatOpen ? 'page' : undefined}
        disabled={!selectedSpace}
        onclick={onOpenChat}
        title="Ask about the whole space, in conversations kept on this machine"
      >
        <MessagesSquare size={15} /> Space chat
      </button>
      <button
        type="button"
        class={['sidebar-nav-item', pushOpen && 'active']}
        aria-current={pushOpen ? 'page' : undefined}
        disabled={!selectedSpace}
        onclick={onOpenPush}
        title="The pages staged in every chat of this space, to push together"
      >
        <Upload size={15} /> Ready to push
        {#if pushCount}<span class="sidebar-nav-count" aria-label="{pushCount} staged">{pushCount}</span>{/if}
      </button>
    </nav>

    <div class="sidebar-tree-tools">
      <Segmented
        label="Show"
        quiet
        value={view}
        onChange={(v) => (view = v)}
        options={[
          { value: 'pages', label: 'Pages' },
          { value: 'tags', label: 'Tags', title: 'Pages grouped by their labels and AI tags' },
        ]}
      />
      {#if view === 'pages'}
        <span class="spacer"></span>
        <button
          type="button"
          class="btn-icon btn-icon-sm"
          onclick={() => (collapsed = new Set())}
          title="Expand all"
          aria-label="Expand all"
        >
          <ChevronsUpDown size={14} />
        </button>
        <button
          type="button"
          class="btn-icon btn-icon-sm"
          onclick={() => (collapsed = withChildren(tree))}
          title="Collapse all"
          aria-label="Collapse all"
        >
          <ChevronsDownUp size={14} />
        </button>
      {/if}
    </div>

    <div class="search-field sidebar-filter" hidden={view !== 'pages'}>
      <ListFilter size={13} />
      <input
        id="tree-filter"
        class="form-input input-sm"
        placeholder="Filter pages"
        aria-label="Filter pages"
        bind:value={pageFilter}
      />
      {#if pageFilter}
        <button type="button" class="icon-btn" onclick={() => (pageFilter = '')} aria-label="Clear the filter"
          ><X size={13} /></button
        >
      {/if}
    </div>
  </div>

  {#if view === 'tags'}
    <TagsView spaceKey={selectedSpace} synced={!!manifest} {selectedPageId} {onSelectPage} onAsk={onAskTag} />
  {/if}
  <div
    hidden={view !== 'pages'}
    class="tree-view-content"
    role="tree"
    aria-label="Pages in {selectedSpace}"
    tabindex="0"
    aria-activedescendant={focusId ? `tree-${focusId}` : undefined}
    onfocus={() => {
      if (!focusId && rows.length)
        focusId = selectedPageId && rows.some((r) => r.node.id === selectedPageId) ? selectedPageId : rows[0].node.id;
    }}
    onkeydown={onTreeKey}
  >
    {#if error}
      <div class="alert alert-error"><AlertTriangle size={14} /> {error}</div>
    {:else if loading}
      <div class="muted tree-message"><RefreshCw size={16} class="spin" /> Loading {selectedSpace}'s pages…</div>
    {:else if !selectedSpace}
      <div class="muted tree-message">
        {#if spacesLoading}<RefreshCw size={16} class="spin" /> Loading the spaces…{:else}Choose a space above.{/if}
      </div>
    {:else if tree.length === 0}
      <div class="muted tree-message">
        No pages found in <strong>{selectedSpace}</strong>. Check your permissions, or paste a page URL in the search
        above.
      </div>
    {:else}
      {#each rows as r (r.node.id)}
        <!-- The tree takes the keyboard (aria-activedescendant), so a row answers only the mouse. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          id="tree-{r.node.id}"
          role="treeitem"
          tabindex="-1"
          aria-selected={r.node.id === selectedPageId}
          aria-expanded={r.hasChildren ? r.expanded : undefined}
          aria-level={r.depth + 1}
          class={['tree-node-item', r.node.id === selectedPageId && 'selected', r.node.id === focusId && 'focused']}
          style:padding-left="{4 + r.depth * 14}px"
          title={r.node.title}
          onclick={() => {
            focusId = r.node.id;
            onSelectPage(r.node.id);
          }}
        >
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <span
            class="tree-toggle-icon"
            role="presentation"
            onclick={(e) => {
              if (!r.hasChildren) return;
              e.stopPropagation();
              toggle(r.node.id);
            }}
          >
            {#if r.hasChildren}
              {#if r.expanded}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
            {/if}
          </span>
          {#if r.hasChildren}
            <Folder size={14} class="tree-icon tree-icon-folder" />
          {:else}
            <FileText size={14} class="tree-icon" />
          {/if}
          <span class="tree-node-title">{r.node.title}</span>
        </div>
      {/each}
    {/if}
  </div>
</div>
