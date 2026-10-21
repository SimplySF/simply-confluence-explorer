<script lang="ts">
  import { Activity, FilePlus2, Layers, Moon, Settings, Sun } from '@lucide/svelte';
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
  import SpacePush from './components/SpacePush.svelte';
  import ObservePage from './components/observe/ObservePage.svelte';
  import { checkConnection } from './support/connection.js';
  import { observe } from './support/observe.svelte.js';
  import type { SpacePage } from './support/pages.js';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Toasts from './components/ui/Toasts.svelte';
  import { api, observability } from './support/api.js';
  import { jobs, type Job } from './support/jobs.svelte.js';
  import { applyTheme, theme, toggleTheme } from './support/theme.svelte.js';
  import { messageOf, toast } from './support/toast.svelte.js';

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
  let dialog = $state<'settings' | 'new-page' | null>(null);
  // The page view, or Space chat in its place; both stay mounted, so each keeps where it was.
  let view = $state<'page' | 'chat' | 'push'>('page');
  let pushCount = $state(0);
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
    checkConnection({ connection: api.connection, verify: () => api.verify(), spaces: api.spaces }).then(
      (state) => {
        if (!live) return;
        connection = state.connection;
        connected = state.connected;
        connUser = state.user ?? '';
        if (state.spacesError) toast(`Signed in, but the spaces did not load: ${state.spacesError}`, 'error');
        if (state.spaces.length === 0) return;
        spaces = state.spaces;
        untrack(() => {
          if (!state.spaces.some((s) => s.key === activeSpace)) chooseSpace(state.spaces[0].key);
        });
      },
      // The server could not be asked at all. The status pill says "Not connected"; Settings shows
      // the reason when the connection is tested.
      () => live && (connected = false),
    );
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

  // The Observability page follows the address, so it opens from a link or in another tab, and the
  // header counts the problems raised since it was last looked at.
  let newProblems = $state(0);
  $effect(() => {
    const follow = (): void => observe.readHash(location.hash);
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  });
  $effect(() => {
    const seen = observe.seenAt;
    const count = (): void => {
      observability.now().then(
        (n) => (newProblems = n.problems.filter((p) => p.at > seen).length),
        () => undefined, // The count is a hint; the page itself reports a server that does not answer.
      );
    };
    count();
    const timer = setInterval(count, 15_000);
    return () => clearInterval(timer);
  });

  // The sidebar counts the staged pages waiting to push; staging happens in a chat, so the count is
  // read again whenever the view changes.
  $effect(() => {
    void view;
    if (!activeSpace) return;
    api.staged(activeSpace).then(
      (s) => (pushCount = s.length),
      () => (pushCount = 0), // The count is a hint; Ready to push reads the list itself.
    );
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
        onclick={() => (observe.open ? observe.close() : observe.show(newProblems ? 'now' : observe.tab))}
        title="What the app is doing, what it recorded, and how each action went"
      >
        <Activity size={14} /> Observability
        {#if newProblems}<span class="observe-badge" title="Problems since you last looked">{newProblems}</span>{/if}
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

  {#if observe.open}
    <ObservePage />
  {/if}
  <div class="workbench-container" hidden={observe.open}>
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
        {pushCount}
        pushOpen={view === 'push'}
        onOpenPush={() => (view = 'push')}
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
      <div class="main-slot" hidden={view !== 'push'}>
        <SpacePush
          spaceKey={activeSpace}
          active={view === 'push'}
          onPushed={() => {
            reloadTree();
            pageRev++;
          }}
          onOpenChat={(p) =>
            openJob({
              kind: 'review',
              jobId: p.runId,
              spaceKey: activeSpace,
              rootPageId: p.chatPageId,
              sessionId: p.sessionId,
              label: p.chatTitle,
              processed: 0,
              total: 0,
            })}
          onCount={(n) => (pushCount = n)}
        />
      </div>
    {/if}
  </div>

  {#if dialog === 'settings'}
    <SettingsDialog onClose={() => (dialog = null)} onSaved={() => connectionRev++} />
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
