<script lang="ts">
  import {
    AlertTriangle,
    BookOpen,
    Copy,
    Download,
    Ellipsis,
    ExternalLink,
    FilePlus2,
    Info,
    ShieldOff,
    Sparkles,
    Tag,
    Trash2,
  } from '@lucide/svelte';
  import type { BranchFinding, PageMetadata, PageResponse } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { forPage } from '../support/pageResult.js';
  import { toast } from '../support/toast.svelte.js';
  import AskAiPanel, { type AiScope } from './AskAiPanel.svelte';
  import DetailsPanel from './DetailsPanel.svelte';
  import PurgePageDialog from './PurgePageDialog.svelte';
  import ReadPanel, { type ReadView } from './ReadPanel.svelte';
  import Menu from './ui/Menu.svelte';
  import Segmented from './ui/Segmented.svelte';

  type Tab = 'read' | 'ai' | 'details';
  const TABS = [
    { id: 'read', label: 'Read', icon: BookOpen },
    { id: 'ai', label: 'Chat & review', icon: Sparkles },
    { id: 'details', label: 'Details', icon: Info },
  ] as const;

  type Props = {
    activeSpace: string;
    page: PageResponse | null;
    loading: boolean;
    error: string | null;
    onSelectPage: (pageId: string) => void;
    onPagePurged: () => void;
    /** Pages were written to Confluence: reload the tree and this page. */
    onPagesChanged: () => void;
    /** A review found a page that should exist: start writing it under this one. */
    onWriteNewPage: (finding: BranchFinding) => void;
    /** Start writing a new page under this one. */
    onNewPage: () => void;
  };

  let {
    activeSpace,
    page,
    loading,
    error,
    onSelectPage,
    onPagePurged,
    onPagesChanged,
    onWriteNewPage,
    onNewPage,
  }: Props = $props();
  let tab = $state<Tab>('read');
  let readView = $state<ReadView>('rendered');
  // Suggestions in this page's chat waiting to be recommended, counted on its tab.
  let openSuggestions = $state(0);
  // A page with sub-pages is asked about together with them unless the person chooses the page alone.
  let scope = $state<AiScope>('branch');
  let purging = $state(false);

  // What the view needs beyond the page itself: whether it is excluded from AI, its AI summary, and how
  // many pages sit under it. Cleared at once on a new page, so one page's facts never show on another.
  let excluded = $state(false);
  let metadata = $state<PageMetadata | null>(null);
  let metadataLoading = $state(false);
  let descendantCount = $state(0);

  const detail = $derived(page?.detail);
  const metaLine = $derived(
    detail
      ? [
          detail.author || 'Unknown author',
          `Updated ${new Date(detail.lastModified).toLocaleDateString()}`,
          `v${detail.version}`,
          detail.attachments.length
            ? `${detail.attachments.length} attachment${detail.attachments.length === 1 ? '' : 's'}`
            : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : '',
  );
  const spaceKey = $derived((detail?.spaceKey || activeSpace).trim().toUpperCase());

  $effect(() => {
    const pageId = detail?.id;
    const key = spaceKey;
    excluded = false;
    metadata = null;
    descendantCount = 0;
    if (!pageId || !key) return;
    let live = true;
    metadataLoading = true;
    // The server enforces exclusion on every AI route; this only labels the page, so an unanswered
    // check leaves the label off rather than blocking the view.
    api.excluded(key, pageId).then(
      (e) => live && (excluded = e),
      () => undefined,
    );
    api
      .metadata(key, pageId)
      .then(
        (m) => live && (metadata = m),
        () => live && (metadata = null),
      )
      .finally(() => live && (metadataLoading = false));
    api.descendants(key, pageId).then(
      (r) => live && (descendantCount = r.count),
      () => live && (descendantCount = 0),
    );
    return () => {
      live = false;
    };
  });

  const current = (): string | undefined => detail?.id;

  // The header opened edits staged from this page's chat: show the chat.
  $effect(() => {
    const wanted = jobs.requested;
    if (!wanted?.sessionId || wanted.rootPageId !== detail?.id) return;
    jobs.requested = null;
    tab = 'ai';
  });
  const setMetadata = (pageId: string, m: PageMetadata | null): void =>
    forPage(pageId, current, (v: PageMetadata | null) => (metadata = v))(m);

  function reloadMetadata(): void {
    if (detail) {
      const pageId = detail.id;
      api.metadata(spaceKey, pageId).then(
        (m) => setMetadata(pageId, m),
        () => setMetadata(pageId, null),
      );
    }
  }

  function download(): void {
    if (!page) return;
    const url = URL.createObjectURL(new Blob([page.parsed.markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${page.detail.title.replace(/[/\\?%*:|"<>]/g, '_')}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function copyMarkdown(): void {
    if (!page) return;
    const xml = readView === 'xml';
    navigator.clipboard.writeText(xml ? page.detail.storageXml : page.parsed.markdown).then(
      () => toast(xml ? 'Storage XML copied.' : 'Markdown copied.', 'success'),
      () => toast('The browser blocked the clipboard; use Read → Markdown and copy from there.', 'error'),
    );
  }
</script>

{#if error}
  <div class="workbench-main empty-main">
    <div class="alert alert-error"><AlertTriangle size={14} /> {error}</div>
  </div>
{:else if loading || !page || !detail}
  <div class="workbench-main empty-main muted">{loading ? 'Loading the page…' : 'Choose a page in the tree.'}</div>
{:else}
  <div class="workbench-main">
    <div class="document-toolbar">
      <div class="document-title-group">
        <nav class="document-breadcrumbs" aria-label="Where this page is">
          <span>{detail.spaceKey}</span>
          {#each detail.ancestors as a (a.id)}
            <span aria-hidden="true">/</span>
            <button class="link-btn" onclick={() => onSelectPage(a.id)}>{a.title}</button>
          {/each}
        </nav>
        <h2 class="document-title">
          <span>{detail.title}</span>
          {#if excluded}
            <span class="pill pill-warn" title="Listed in .confluenceignore: never sent to an AI">
              <ShieldOff size={12} /> Excluded from AI
            </span>
          {/if}
        </h2>
        <p class="document-meta">
          <span>{metaLine}</span>
          {#each detail.labels as l (l)}<span class="document-label"><Tag size={12} /> {l}</span>{/each}
        </p>
      </div>
      <div class="toolbar-buttons">
        {#if detail.webUrl}
          <a
            href={detail.webUrl}
            target="_blank"
            rel="noreferrer"
            class="btn btn-secondary btn-square"
            title="Open in Confluence"
            aria-label="Open in Confluence"
          >
            <ExternalLink size={14} />
          </a>
        {/if}
        <Menu
          title="More for this page"
          buttonClass="btn btn-secondary btn-square"
          items={[
            { label: readView === 'xml' ? 'Copy Storage XML' : 'Copy Markdown', icon: Copy, onSelect: copyMarkdown },
            { label: 'Download .md', icon: Download, onSelect: download },
            'divider',
            {
              label: 'Remove from this machine…',
              icon: Trash2,
              danger: true,
              hint: 'Deletes the synced copy; Confluence is not changed',
              onSelect: () => (purging = true),
            },
          ]}
        >
          {#snippet label()}<Ellipsis size={14} />{/snippet}
        </Menu>
        <button class="btn btn-secondary" onclick={onNewPage} title="Write a new page under “{detail.title}”">
          <FilePlus2 size={14} /> New sub-page
        </button>
        <button
          class="btn btn-primary"
          onclick={() => (tab = 'ai')}
          title="Ask about this page, and review it for problems, in its chat"
        >
          <Sparkles size={14} /> Review with AI
        </button>
      </div>
    </div>

    <div class="view-tabs">
      <div class="view-tabs-list" role="tablist">
        {#each TABS as t (t.id)}
          <button
            role="tab"
            aria-selected={tab === t.id}
            class={['tab-btn', tab === t.id && 'active']}
            onclick={() => (tab = t.id)}
          >
            <t.icon size={14} />
            {t.label}
            {#if t.id === 'ai' && openSuggestions}<span class="tab-count" title="Suggestions to recommend"
                >{openSuggestions}</span
              >{/if}
          </button>
        {/each}
      </div>
      {#if tab === 'read'}
        <Segmented
          label="View"
          value={readView}
          onChange={(v) => (readView = v)}
          options={[
            { value: 'rendered', label: 'Rendered' },
            { value: 'markdown', label: 'Markdown' },
            { value: 'xml', label: 'Storage XML', title: 'The page as Confluence stores it' },
          ]}
        />
      {/if}
    </div>

    <!-- Every panel stays mounted, so a question being typed or a proposal being edited survives a tab switch. -->
    <div class="tab-pane tab-pane-read" hidden={tab !== 'read'}><ReadPanel {page} view={readView} /></div>
    <div class="tab-pane tab-pane-fill" hidden={tab !== 'ai'}>
      <AskAiPanel
        {detail}
        {spaceKey}
        {excluded}
        {descendantCount}
        {scope}
        onScopeChange={(s) => (scope = s)}
        active={tab === 'ai'}
        {onSelectPage}
        onPushed={onPagesChanged}
        {onWriteNewPage}
        onOpenCount={(n) => (openSuggestions = n)}
      />
    </div>
    <div class="tab-pane" hidden={tab !== 'details'}>
      <DetailsPanel
        {page}
        {spaceKey}
        {descendantCount}
        {metadata}
        {metadataLoading}
        onMetadata={setMetadata}
        onMetadataLoading={(pageId, b) => forPage(pageId, current, (v: boolean) => (metadataLoading = v))(b)}
        {reloadMetadata}
      />
    </div>

    {#if purging}
      <PurgePageDialog
        {detail}
        {spaceKey}
        {descendantCount}
        onClose={() => (purging = false)}
        onPurged={() => {
          purging = false;
          onPagePurged();
        }}
      />
    {/if}
  </div>
{/if}
