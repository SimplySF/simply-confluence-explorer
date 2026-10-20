<script lang="ts">
  import {
    Check,
    ExternalLink,
    Eye,
    FilePlus2,
    Paperclip,
    Pencil,
    RefreshCw,
    Search,
    Send,
    ShieldCheck,
    Square,
    Upload,
  } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { AiSessionView, RedundancyDecision, SeriesPage } from '../../../src/api/types.js';
  import { drafts, sessions, type DraftSummary } from '../support/api.js';
  import { messageOf } from '../support/toast.svelte.js';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
  import Dialog from './ui/Dialog.svelte';
  import Diff from './ui/Diff.svelte';
  import Markdown from './ui/Markdown.svelte';

  // A new page, in the order that keeps a space from repeating itself: say what the page is for, see
  // what already says it, answer that, then write it with the co-writer and create it (ADR-025).
  type Props = {
    spaceKey: string;
    parentId: string;
    parentTitle: string;
    /** What the page should cover, when a review suggested it. */
    notes?: string;
    /** The space's pages, to choose one whose structure to follow; excluded pages are never among them. */
    pages: Array<{ id: string; title: string }>;
    onClose: () => void;
    /** The author chose to work on an existing page instead, or opens the new one. */
    onOpenPage: (pageId: string) => void;
    onCreated: () => void;
  };

  let {
    spaceKey,
    parentId,
    parentTitle,
    notes: suggested = '',
    pages,
    onClose,
    onOpenPage,
    onCreated,
  }: Props = $props();
  // A series: the overview is the draft itself (tab 0), and its child pages follow.
  let children = $state<SeriesPage[]>([]);
  let tab = $state(0);
  let exampleTitle = $state('');
  let template = $state('');
  let repoLink = $state('');
  const OVERLAP_LABEL = { high: 'Already covers this', some: 'Covers part of it', low: 'Little overlap' } as const;
  const UPLOAD_TYPES = '.pdf,.md,.markdown,.txt,.csv,.tsv,.json,.yaml,.yml,.log,.xml,.html,.htm';

  let session = $state<AiSessionView | null>(null);
  let unfinished = $state<DraftSummary[]>([]);
  let title = $state('');
  let notes = $state(untrack(() => suggested));
  let linked = $state<string[]>([]);
  let markdown = $state('');
  let preview = $state(false);
  let prompt = $state('');
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let checkOk = $state<string | null>(null);
  let confirmCreate = $state(false);
  let fileInput = $state<HTMLInputElement>();

  $effect(() => {
    drafts.unfinished(spaceKey).then(
      (d) => (unfinished = d),
      () => (unfinished = []),
    );
  });

  const d = $derived(session?.draft);
  const stage = $derived(
    !session
      ? 'describe'
      : !d?.redundancy?.decision
        ? 'check'
        : d.createdPageId && (d.children ?? []).every((c) => c.createdPageId)
          ? 'done'
          : 'write',
  );
  const pageCount = $derived(1 + children.length);

  function load(s: AiSessionView): void {
    session = s;
    markdown = s.draft?.markdown ?? '';
    title = s.draft?.title ?? '';
    template = s.draft?.template ?? '';
    children = (s.draft?.children ?? []).map((c) => ({ ...c }));
    if (tab > children.length) tab = 0;
    exampleTitle = pages.find((p) => p.id === s.draft?.examplePageId)?.title ?? '';
    checkOk = null;
  }

  // The question being answered, so Stop can end it and put it back in the box (ADR-047).
  let asking = $state<{ prompt: string; stopper: AbortController } | null>(null);

  async function act(label: string, fn: () => Promise<AiSessionView | void>): Promise<void> {
    busy = label;
    error = null;
    try {
      const s = await fn();
      if (s) load(s);
    } catch (e) {
      // A stopped question is not an error: the author is about to ask it again.
      if (label !== 'send' || !asking?.stopper.signal.aborted) error = messageOf(e);
    } finally {
      busy = null;
      if (label === 'send') asking = null;
    }
  }

  function stopAsking(): void {
    if (!asking) return;
    asking.stopper.abort();
    prompt = asking.prompt;
  }

  // The editor saves itself shortly after typing stops; the overview cannot change once it is created.
  $effect(() => {
    const text = markdown;
    const id = session?.id;
    if (stage !== 'write' || !id || text === d?.markdown || d?.createdPageId) return;
    const t = setTimeout(() => {
      drafts.save(id, { markdown: text }).then(
        (s) => (session = s),
        (e: unknown) => (error = messageOf(e)),
      );
    }, 800);
    return () => clearTimeout(t);
  });

  // A series' pages save themselves the same way.
  $effect(() => {
    const pages = JSON.stringify(children.map((c) => ({ title: c.title, markdown: c.markdown })));
    const id = session?.id;
    const saved = JSON.stringify((d?.children ?? []).map((c) => ({ title: c.title, markdown: c.markdown })));
    if (stage !== 'write' || !id || pages === saved) return;
    const timer = setTimeout(() => {
      drafts.save(id, { children: JSON.parse(pages) as SeriesPage[] }).then(
        (s) => (session = s),
        (e: unknown) => (error = messageOf(e)),
      );
    }, 800);
    return () => clearTimeout(timer);
  });

  // Only the newest proposal is offered, and only until the author accepts or dismisses it; an older
  // one is never brought back, because it was made from a draft that has changed since.
  const proposal = $derived.by(() => {
    const turns = session?.turns ?? [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const text = turns[i].proposedDraft;
      const series = turns[i].proposedSeries;
      if (text || series?.length) return turns[i].proposalClosed ? null : { index: i, text, series };
    }
    return null;
  });

  function acceptSeries(series: SeriesPage[], index: number): void {
    if (!session) return;
    const { id } = session;
    const [overview, ...rest] = series;
    tab = 0;
    void act('series', async () => {
      await drafts.closeProposal(id, index);
      return drafts.save(id, {
        title: overview.title,
        markdown: overview.markdown,
        children: rest.map((p) => ({ title: p.title, markdown: p.markdown })),
      });
    });
  }

  const decide = (decision: RedundancyDecision): Promise<void> =>
    act(decision, () => drafts.decide(session!.id, decision, decision === 'link' ? linked : []));

  // Only the turns are taken from the answer: the draft's text may hold an accepted proposal that is
  // not saved yet, and must not be put back to what the server last saved.
  const dismiss = (index: number): void => {
    if (!session) return;
    drafts.closeProposal(session.id, index).then(
      (s) => {
        if (session) session = { ...session, turns: s.turns };
      },
      (e: unknown) => (error = messageOf(e)),
    );
  };

  function send(e: SubmitEvent): void {
    e.preventDefault();
    const p = prompt.trim();
    if (!p || !session) return;
    const { id } = session;
    prompt = '';
    const stopper = new AbortController();
    asking = { prompt: p, stopper };
    void act('send', () => drafts.save(id, { markdown }).then(() => drafts.send(id, p, stopper.signal)));
  }

  /** Saves the example page and structure the co-writer follows. */
  function saveGuides(): void {
    if (!session) return;
    const { id } = session;
    const example = pages.find((p) => p.title.toLowerCase() === exampleTitle.trim().toLowerCase());
    if (exampleTitle.trim() && !example) {
      error = `No page called “${exampleTitle.trim()}” in ${spaceKey}.`;
      return;
    }
    void act('guides', () => drafts.save(id, { examplePageId: example?.id ?? '', template }));
  }

  function addRepository(): void {
    if (!session || !repoLink.trim()) return;
    const { id } = session;
    const link = repoLink.trim();
    void act('repo', async () => {
      const s = await drafts.addRepository(id, link);
      repoLink = '';
      return s;
    });
  }

  function addFiles(files: File[]): void {
    if (!session) return;
    const { id } = session;
    void act('files', async () => {
      let s: AiSessionView | null = null;
      for (const f of files) s = await sessions.addFile(id, f); // eslint-disable-line no-await-in-loop -- one at a time keeps the order
      return s ?? undefined;
    });
  }

  function create(): void {
    confirmCreate = false;
    if (!session) return;
    const { id } = session;
    void act('create', async () => {
      await drafts.save(id, { markdown });
      const s = await drafts.create(id);
      onCreated();
      return s;
    });
  }
</script>

{#snippet writeFooter()}
  <span class="branch-note">Saved as you type. Nothing is in Confluence until you create it.</span>
  <button
    class="btn btn-secondary"
    disabled={!!busy}
    onclick={() =>
      session &&
      act('check', async () => {
        await drafts.save(session!.id, {
          ...(d?.createdPageId ? {} : { markdown }),
          children: children.map((c) => ({ title: c.title, markdown: c.markdown })),
        });
        await drafts.check(session!.id);
        checkOk = `Dry run passed: Confluence will accept ${pageCount === 1 ? 'this page' : `all ${pageCount} pages`}.`;
      })}
  >
    {#if busy === 'check'}<RefreshCw size={14} class="spin" />{:else}<Check size={14} />{/if} Dry run
  </button>
  <button class="btn btn-primary" disabled={!!busy} onclick={() => (confirmCreate = true)}>
    {#if busy === 'create'}<RefreshCw size={14} class="spin" />{:else}<Upload size={14} />{/if} Create {pageCount === 1
      ? 'page'
      : `${pageCount} pages`}
  </button>
{/snippet}

<Dialog size="new-page" {onClose} footer={stage === 'write' ? writeFooter : undefined}>
  {#snippet header()}<FilePlus2 size={16} /> New page in {spaceKey}, under “{d?.parentTitle || parentTitle}”{/snippet}
  {#if error}<div class="branch-error">{error}</div>{/if}

  {#if stage === 'describe'}
    <div class="new-page-describe">
      <label class="form-label" for="new-page-title">Title</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        id="new-page-title"
        class="form-input"
        bind:value={title}
        placeholder="e.g. Schema Migration Guide"
        autofocus
      />
      <label class="form-label" for="new-page-notes">What should this page cover?</label>
      <textarea
        id="new-page-notes"
        class="form-input"
        rows="5"
        bind:value={notes}
        placeholder="Notes, an outline, who it is for. This is what the check for similar pages searches with."
      ></textarea>
      <button
        class="btn btn-primary"
        disabled={!title.trim() || !!busy}
        onclick={() => act('start', () => drafts.start({ spaceKey, parentId, title, notes }))}
      >
        {#if busy === 'start'}<RefreshCw size={14} class="spin" />{:else}<Search size={14} />{/if} Check for similar pages
      </button>
      {#if unfinished.length > 0}
        <div class="branch-history">
          <h4>Continue a draft</h4>
          {#each unfinished as s (s.id)}
            <button class="branch-history-row" onclick={() => act('open', () => sessions.get(s.id))}>
              {s.draft?.title} · under {s.draft?.parentTitle} · {new Date(s.updatedAt).toLocaleString()}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else if stage === 'check' && d?.redundancy}
    <div class="new-page-check">
      <p class="branch-note">
        Before writing “{d.title}”, check whether an existing page already says it. {d.redundancy.note ?? ''}
      </p>
      {#if d.redundancy.similar.length === 0}<p>No similar pages were found.</p>{/if}
      {#each d.redundancy.similar as p (p.pageId)}
        <div class="similar-page overlap-{p.overlap ?? 'unknown'}">
          <label class="checkbox-group">
            <input
              type="checkbox"
              checked={linked.includes(p.pageId)}
              onchange={(e) =>
                (linked = e.currentTarget.checked ? [...linked, p.pageId] : linked.filter((x) => x !== p.pageId))}
            />
            <strong>{p.title}</strong>
          </label>
          <span class="branch-status">
            {p.overlap
              ? OVERLAP_LABEL[p.overlap]
              : p.source === 'synced'
                ? 'Found in the synced copy'
                : 'Found by Confluence search'}
          </span>
          {#if p.why}<p>{p.why}</p>{/if}
          {#if p.excerpt}<p class="branch-note">{p.excerpt}</p>{/if}
          <button
            class="btn btn-secondary btn-sm"
            onclick={() => decide('update-existing').then(() => onOpenPage(p.pageId))}
          >
            Update this page instead
          </button>
        </div>
      {/each}
      <div class="branch-actions">
        <button class="btn btn-primary" disabled={!linked.length || !!busy} onclick={() => decide('link')}>
          Link to {linked.length || 'the'} selected and continue
        </button>
        <button class="btn btn-secondary" disabled={!!busy} onclick={() => decide('continue')}>Continue anyway</button>
        <button
          class="btn btn-secondary"
          disabled={!!busy}
          onclick={() => act('recheck', () => drafts.recheck(session!.id))}
        >
          <RefreshCw size={13} /> Check again
        </button>
      </div>
    </div>
  {:else if stage === 'write' && session && d}
    <div class="new-page-write">
      <div class="new-page-editor">
        {#if children.length > 0}
          <div class="new-page-series" role="tablist" aria-label="Pages of the series">
            {#each [{ title, createdPageId: d.createdPageId }, ...children] as p, i (i)}
              <button
                type="button"
                role="tab"
                aria-selected={tab === i}
                class={['new-page-series-tab', tab === i && 'active']}
                onclick={() => (tab = i)}
              >
                {i === 0 ? 'Overview: ' : ''}{p.title}{p.createdPageId ? ' (created)' : ''}
              </button>
            {/each}
          </div>
        {/if}
        <div class="branch-runbar">
          {#if tab === 0}
            <input
              class="form-input"
              aria-label="Title"
              bind:value={title}
              disabled={!!d.createdPageId}
              onblur={() =>
                title.trim() && title !== d.title && act('title', () => drafts.save(session!.id, { title }))}
            />
          {:else}
            <input
              class="form-input"
              aria-label="Title of this page"
              bind:value={children[tab - 1].title}
              disabled={!!children[tab - 1].createdPageId}
            />
          {/if}
          <button class="btn btn-secondary btn-sm" onclick={() => (preview = !preview)}>
            {#if preview}<Pencil size={13} />{:else}<Eye size={13} />{/if}
            {preview ? 'Edit' : 'Preview'}
          </button>
        </div>
        {#if tab > 0 && children[tab - 1].similar?.length}
          <div class="branch-note">
            Similar pages already in the space: {children[tab - 1].similar?.map((s) => s.title).join(', ')}.
          </div>
        {/if}
        {#if preview}
          <Markdown
            source={tab === 0 ? markdown : children[tab - 1].markdown}
            extraClass="markdown-preview new-page-preview"
          />
        {:else if tab === 0}
          <textarea
            class="form-input branch-editor"
            aria-label="Page content"
            bind:value={markdown}
            disabled={!!d.createdPageId}
          ></textarea>
        {:else}
          <textarea
            class="form-input branch-editor"
            aria-label="Content of this page"
            bind:value={children[tab - 1].markdown}
            disabled={!!children[tab - 1].createdPageId}
          ></textarea>
        {/if}
        {#if checkOk}<div class="guard-note"><Check size={12} /> {checkOk}</div>{/if}
      </div>

      <div class="new-page-chat">
        <details class="new-page-reads">
          <summary
            >What the co-writer reads: notes, files{d.examplePageId ? ', an example page' : ''}{d.template
              ? ', a structure'
              : ''}{session.files.some((x) => x.name.endsWith('(GitLab).md')) ? ', GitLab' : ''}</summary
          >
          <label class="form-label" for="np-example">Follow the structure of an existing page</label>
          <input
            id="np-example"
            class="form-input input-sm"
            list="np-pages"
            placeholder="Start typing a page title, such as another service's page"
            bind:value={exampleTitle}
          />
          <datalist id="np-pages"
            >{#each pages as p (p.id)}<option value={p.title}></option>{/each}</datalist
          >
          <label class="form-label" for="np-template">Or paste a structure to follow</label>
          <textarea
            id="np-template"
            class="form-input"
            rows="3"
            placeholder="## Overview&#10;## Architecture&#10;## Runbook"
            bind:value={template}
          ></textarea>
          <button class="btn btn-secondary btn-sm" disabled={busy === 'guides'} onclick={saveGuides}>
            <Check size={13} /> Use these
          </button>
          <label class="form-label" for="np-repo">Read a GitLab repository</label>
          <form
            class="row"
            onsubmit={(e) => {
              e.preventDefault();
              addRepository();
            }}
          >
            <input
              id="np-repo"
              class="form-input input-sm"
              placeholder="https://gitlab.yourcompany.com/group/service"
              bind:value={repoLink}
            />
            <button class="btn btn-secondary btn-sm" disabled={!repoLink.trim() || busy === 'repo'}>
              {busy === 'repo' ? 'Reading…' : 'Add'}
            </button>
          </form>
          <span class="branch-note"
            >Its README, docs, API files and manifest are added as a file. Set GitLab up in Settings.</span
          >
        </details>
        <div class="new-page-turns">
          {#if session.turns.length === 0}
            <p class="branch-note">
              Ask the co-writer for an outline, a section, or a review of what you have. Its changes arrive as proposals
              for you to accept.
            </p>
          {/if}
          {#each session.turns as t, i (i)}
            <div class="chat-turn turn-{t.role}">
              <Markdown source={t.text} extraClass="" />
              {#if t.guardSummary}<div class="guard-note"><ShieldCheck size={11} /> {t.guardSummary}</div>{/if}
            </div>
          {/each}
        </div>
        {#if proposal?.series?.length}
          <div class="new-page-proposal">
            <strong>Proposed series of {proposal.series.length} pages</strong>
            <ol class="plain-list">
              {#each proposal.series as p, i (i)}<li>{i === 0 ? 'Overview: ' : ''}{p.title}</li>{/each}
            </ol>
            <p class="branch-note">
              Accepting replaces the draft with these pages; the children go under the overview.
            </p>
            <div class="branch-actions">
              <button class="btn btn-primary btn-sm" onclick={() => acceptSeries(proposal.series!, proposal.index)}>
                <Check size={13} /> Accept the series
              </button>
              <button class="btn btn-secondary btn-sm" onclick={() => dismiss(proposal.index)}>Dismiss</button>
            </div>
          </div>
        {:else if proposal?.text}
          <div class="new-page-proposal">
            <strong>Proposed change</strong>
            <Diff before={markdown} after={proposal.text} />
            <div class="branch-actions">
              <button
                class="btn btn-primary btn-sm"
                onclick={() => {
                  markdown = proposal.text!;
                  dismiss(proposal.index);
                }}
              >
                <Check size={13} /> Accept
              </button>
              <button class="btn btn-secondary btn-sm" onclick={() => dismiss(proposal.index)}>Dismiss</button>
            </div>
          </div>
        {/if}
        {#if session.files.length > 0}
          <div class="chat-files">
            {#each session.files as f (f.id)}<span class="chat-file"><Paperclip size={11} /> {f.name}</span>{/each}
          </div>
        {/if}
        <form class="new-page-input" onsubmit={send}>
          <input
            bind:this={fileInput}
            type="file"
            multiple
            hidden
            accept={UPLOAD_TYPES}
            onchange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = '';
              if (files.length) addFiles(files);
            }}
          />
          <button
            type="button"
            class="btn btn-secondary"
            onclick={() => fileInput?.click()}
            title="Add files as context"
            aria-label="Add files"
          >
            <Paperclip size={14} />
          </button>
          <input
            class="form-input"
            aria-label="Ask the co-writer"
            bind:value={prompt}
            placeholder="e.g. Draft an outline from my notes"
            disabled={busy === 'send'}
          />
          {#if busy === 'send'}
            <button
              type="button"
              class="btn btn-secondary"
              onclick={stopAsking}
              aria-label="Stop"
              title="Stop the answer and put the question back to edit"
            >
              <Square size={13} />
            </button>
          {:else}
            <button class="btn btn-primary" disabled={!prompt.trim()} aria-label="Send"><Send size={14} /></button>
          {/if}
        </form>
      </div>
    </div>
  {:else if stage === 'done' && d}
    <div class="new-page-done">
      <p>
        <strong>{d.title}</strong> was created in {spaceKey}{#if d.children?.length}, with {d.children.length} page{d
            .children.length === 1
            ? ''
            : 's'} under it: {d.children.map((c) => c.title).join(', ')}{/if}.
      </p>
      <div class="branch-actions">
        <button class="btn btn-primary" onclick={() => d.createdPageId && onOpenPage(d.createdPageId)}
          >Open it here</button
        >
        {#if d.createdUrl}
          <a class="btn btn-secondary" href={d.createdUrl} target="_blank" rel="noreferrer"
            ><ExternalLink size={13} /> Open in Confluence</a
          >
        {/if}
      </div>
    </div>
  {/if}

  {#if confirmCreate && session}
    <ConfirmDialog
      title={pageCount === 1 ? 'Create this page in Confluence?' : `Create these ${pageCount} pages in Confluence?`}
      onCancel={() => (confirmCreate = false)}
      onConfirm={create}
    >
      {#snippet confirmLabel()}<Upload size={14} /> Create{/snippet}
      <p>
        <strong>{title}</strong> is created under “{d?.parentTitle}” in {spaceKey}{children.length
          ? `, then ${children.map((c) => c.title).join(', ')} under it, in that order`
          : ''}. A title already used in the space is refused; if one is, the pages already created are named and the
        rest stay here to create again.
      </p>
    </ConfirmDialog>
  {/if}
</Dialog>
