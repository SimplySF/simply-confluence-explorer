<script lang="ts">
  import { FileCode, FilePlus2, Layers, Moon, Settings, Sun } from '@lucide/svelte';
  import { onMount, untrack } from 'svelte';
  import type {
    BranchFinding,
    ConfluenceSpace,
    ConnectionView,
    PageResponse,
    PageTreeNode,
  } from '../../src/api/types.js';
  import JobsBar from './components/JobsBar.svelte';
  import NewPageDialog from './components/NewPageDialog.svelte';
  import PageView from './components/PageView.svelte';
  import SpaceChat, { type ChatSeed } from './components/SpaceChat.svelte';
  import type { SpacePage } from './support/pages.js';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import SnippetDialog from './components/SnippetDialog.svelte';
  import Toasts from './components/ui/Toasts.svelte';
  import { api } from './support/api.js';
  import { jobs, type Job } from './support/jobs.svelte.js';
  import { applyTheme, theme, toggleTheme } from './support/theme.svelte.js';
  import { messageOf } from './support/toast.svelte.js';

  const remembered = (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null; // Storage blocked: nothing is remembered between visits.
    }
  };
  const remember = (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage blocked: the choice holds until the page is closed.
    }
  };

  const contains = (nodes: PageTreeNode[], id: string | null): boolean =>
    !!id && nodes.some((n) => n.id === id || contains(n.children, id));

  /** A key typed into a field belongs to the field, not to a shortcut. */
  const typingIn = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
  };

  // Bumped when the connection is saved, so everything that depends on it reloads.
  let connectionRev = $state(0);
  // Bumped to read the tree again after a sync, a purge or a write.
  let treeRev = $state(0);
  // Bumped after pages are written, so the open page is read again.
  let pageRev = $state(0);

  let connection = $state<ConnectionView | null>(null);
  let connected = $state(false);
  let connUser = $state('');
  let spaces = $state<ConfluenceSpace[]>([]);
  let activeSpace = $state(remembered('active_space') ?? '');
  let tree = $state<PageTreeNode[]>([]);
  let treeLoading = $state(false);
  let treeError = $state<string | null>(null);
  let selectedPageId = $state<string | null>(null);
  let page = $state<PageResponse | null>(null);
  let pageLoading = $state(false);
  let pageError = $state<string | null>(null);

  let sidebarWidth = $state(Math.max(260, Math.min(850, Number(remembered('sidebar_width')) || 340)));
  let resizing = $state(false);
  let dialog = $state<'settings' | 'snippet' | 'new-page' | null>(null);
  // The page view, or Space chat in its place; both stay mounted, so each keeps where it was.
  let view = $state<'page' | 'chat'>('page');
  let chatSeed = $state<ChatSeed | null>(null);
  // Every page with where it sits and the pages under it, so a chat can add a directory in one step.
  const flatten = (nodes: PageTreeNode[], path: string[] = []): SpacePage[] =>
    nodes.flatMap((n) => {
      const below = flatten(n.children, [...path, n.title]);
      const under = below.map((p) => p.id);
      return [{ id: n.id, title: n.title, path: path.join(' › '), under }, ...below];
    });
  const allPages = $derived(flatten(tree));

  function openPage(id: string): void {
    selectedPageId = id;
    view = 'page';
  }

  // What a review said a new page should cover, to start the new-page dialog with.
  let newPageNotes = $state('');

  onMount(() => {
    applyTheme();
    // Ctrl+, opens Settings; / jumps to the page filter.
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        dialog = dialog === 'settings' ? null : 'settings';
      } else if (
        e.key === '/' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !typingIn(e.target) &&
        !document.querySelector('.modal-overlay')
      ) {
        e.preventDefault();
        document.getElementById('tree-filter')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  $effect(() => {
    if (!resizing) return;
    const move = (e: MouseEvent): void => {
      sidebarWidth = Math.max(260, Math.min(850, e.clientX));
    };
    const up = (): void => {
      resizing = false;
      remember('sidebar_width', String(sidebarWidth));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  });

  $effect(() => {
    void connectionRev;
    let live = true;
    (async () => {
      const view = await api.connection();
      if (!live) return;
      connection = view;
      if (!view.baseUrl) {
        connected = false;
        return;
      }
      const verified = await api.verify();
      if (!live) return;
      connected = verified.success;
      connUser = verified.user?.displayName ?? 'User';
      const list = await api.spaces();
      if (!live || list.length === 0) return;
      spaces = list;
      untrack(() => {
        if (!list.some((s) => s.key === activeSpace)) chooseSpace(list[0].key);
      });
    })().catch(() => {
      // The status pill says "Not connected"; Settings shows the reason when the connection is tested.
      if (live) connected = false;
    });
    return () => {
      live = false;
    };
  });

  $effect(() => {
    void connectionRev;
    void treeRev;
    const key = activeSpace;
    if (!key) return;
    let live = true;
    treeLoading = true;
    treeError = null;
    api
      .tree(key)
      .then(
        (t) => {
          if (!live) return;
          tree = t;
          if (
            !contains(
              t,
              untrack(() => selectedPageId),
            )
          )
            selectedPageId = t[0]?.id ?? null;
        },
        (e: unknown) => live && (treeError = `The pages of ${key} could not be loaded: ${messageOf(e)}`),
      )
      .finally(() => live && (treeLoading = false));
    return () => {
      live = false;
    };
  });

  $effect(() => {
    void connectionRev;
    void pageRev;
    const id = selectedPageId;
    if (!id) return;
    let live = true;
    pageLoading = true;
    pageError = null;
    api
      .page(
        id,
        untrack(() => activeSpace),
      )
      .then(
        (p) => live && (page = p),
        (e: unknown) => live && (pageError = `This page could not be loaded: ${messageOf(e)}`),
      )
      .finally(() => live && (pageLoading = false));
    return () => {
      live = false;
    };
  });

  // Work started earlier, in this tab or before a reload, keeps reporting in the header.
  $effect(() => {
    if (activeSpace) jobs.resume(activeSpace);
  });

  function openJob(job: Job): void {
    chooseSpace(job.spaceKey);
    if (job.kind !== 'review' && job.kind !== 'batch') {
      if (job.rootPageId) openPage(job.rootPageId);
      return;
    }
    // Edits and batched reviews are shown in the chat they came from: a page's Chat tab, or Space chat.
    jobs.requested = job;
    if (job.rootPageId) openPage(job.rootPageId);
    else view = 'chat';
  }

  function writeNewPage(finding: BranchFinding): void {
    newPageNotes = [finding.detail, finding.suggestion].filter(Boolean).join('\n\n');
    dialog = 'new-page';
  }

  function chooseSpace(spaceKey: string): void {
    const key = spaceKey.trim().toUpperCase();
    remember('active_space', key);
    activeSpace = key;
    if (!spaces.some((s) => s.key.toUpperCase() === key)) {
      api.space(key).then(
        (s) => (spaces = [s, ...spaces]),
        () => (spaces = [{ key, name: key, type: 'global' }, ...spaces]),
      );
    }
  }

  const reloadTree = (): number => treeRev++;
  const statusLabel = $derived(
    connected ? `Connected (${connUser})` : connection && !connection.baseUrl ? 'Not configured' : 'Not connected',
  );
</script>

<div class="app-shell">
  <header class="app-header">
    <div class="brand-section">
      <div class="brand-icon"><Layers size={18} /></div>
      <div class="brand-title">Confluence Explorer</div>
      <span class="brand-badge">Server / DC</span>
      <button
        type="button"
        class={['status-pill', connected ? 'connected' : 'disconnected']}
        onclick={() => (dialog = 'settings')}
        title="Connection settings (Ctrl+,)"
      >
        <span class="status-dot"></span>
        <span>{statusLabel}</span>
      </button>
      <JobsBar onOpen={openJob} />
    </div>
    <div class="header-actions">
      <button
        class="btn btn-primary btn-sm"
        onclick={() => (dialog = 'new-page')}
        disabled={!page}
        title={page
          ? `Write a new page under “${page.detail.title}”`
          : 'Choose the page the new one goes under, in the tree'}
      >
        <FilePlus2 size={14} /> New page
      </button>
      <button
        class="btn btn-secondary btn-sm"
        onclick={() => (dialog = 'snippet')}
        title="Convert a pasted storage-format snippet to Markdown"
      >
        <FileCode size={14} /> Snippet parser
      </button>
      <button
        class="btn btn-secondary btn-sm"
        onclick={() => (dialog = 'settings')}
        title="Connection and AI provider (Ctrl+,)"
      >
        <Settings size={14} /> Settings
      </button>
      <button
        class="btn btn-secondary btn-sm"
        onclick={toggleTheme}
        title={theme.current === 'dark' ? 'Light theme' : 'Dark theme'}
        aria-label="Switch theme"
      >
        {#if theme.current === 'dark'}<Sun size={14} />{:else}<Moon size={14} />{/if}
      </button>
    </div>
  </header>

  <div class="workbench-container">
    <div class="sidebar-slot" style:width="{sidebarWidth}px" style:min-width="{sidebarWidth}px">
      <Sidebar
        {spaces}
        selectedSpace={activeSpace}
        onSelectSpace={chooseSpace}
        {tree}
        {selectedPageId}
        onSelectPage={openPage}
        onJump={(target) => {
          chooseSpace(target.spaceKey);
          if (target.pageId) openPage(target.pageId);
        }}
        chatOpen={view === 'chat'}
        onOpenChat={() => (view = 'chat')}
        onAskTag={(t) => {
          chatSeed = {
            title: `#${t.tag}`,
            scope: {
              kind: 'pages',
              spaceKey: activeSpace,
              tags: [t.tag],
            },
          };
          view = 'chat';
        }}
        loading={treeLoading}
        error={treeError}
        onTreeChanged={reloadTree}
      />
    </div>
    <!-- A drag handle for the mouse; the sidebar's width is not something the keyboard needs to set. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class={['sidebar-resizer', resizing && 'resizing']}
      role="separator"
      aria-orientation="vertical"
      onmousedown={(e) => {
        e.preventDefault();
        resizing = true;
      }}
      title="Drag to resize"
    ></div>
    <!-- A page read again after a write stays on screen, so an open workspace and its results survive. -->
    <div class="main-slot" hidden={view !== 'page'}>
      <PageView
        {activeSpace}
        {page}
        loading={pageLoading && page?.detail.id !== selectedPageId}
        error={pageError}
        onSelectPage={(id) => (selectedPageId = id)}
        onPagesChanged={() => {
          reloadTree();
          pageRev++;
        }}
        onPagePurged={() => {
          reloadTree();
          selectedPageId = null;
          page = null;
        }}
        onWriteNewPage={writeNewPage}
      />
    </div>
    {#if activeSpace}
      <div class="main-slot" hidden={view !== 'chat'}>
        <SpaceChat
          spaceKey={activeSpace}
          pages={allPages}
          seed={chatSeed}
          onSeeded={() => (chatSeed = null)}
          active={view === 'chat'}
          onSelectPage={openPage}
          onPushed={() => {
            reloadTree();
            pageRev++;
          }}
          onWriteNewPage={writeNewPage}
        />
      </div>
    {/if}
  </div>

  {#if dialog === 'settings'}
    <SettingsDialog onClose={() => (dialog = null)} onSaved={() => connectionRev++} />
  {:else if dialog === 'snippet'}
    <SnippetDialog onClose={() => (dialog = null)} />
  {:else if dialog === 'new-page' && page}
    <NewPageDialog
      spaceKey={(page.detail.spaceKey || activeSpace).toUpperCase()}
      parentId={page.detail.id}
      parentTitle={page.detail.title}
      notes={newPageNotes}
      pages={allPages}
      onClose={() => {
        dialog = null;
        newPageNotes = '';
      }}
      onOpenPage={(id) => {
        dialog = null;
        selectedPageId = id;
      }}
      onCreated={reloadTree}
    />
  {/if}
  <Toasts />
</div>
