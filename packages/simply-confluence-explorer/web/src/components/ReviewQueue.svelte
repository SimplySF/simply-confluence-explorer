<script lang="ts">
  import { FilePlus2, History, RefreshCw, Sparkles, X } from '@lucide/svelte';
  import type { BranchFinding, SuggestionView } from '../../../src/api/types.js';

  // A chat's review queue (ADR-060), in three parts: suggestions to recommend, those whose edits are
  // in progress, and those that are closed. Ticked suggestions become one edit for each page they
  // name, each page read fresh from Confluence first (ADR-061). The chat itself can reword, add and
  // remove them; each earlier wording is kept and can be brought back.
  type Props = {
    suggestions: SuggestionView[];
    busy: boolean;
    onRecommend: (ids: string[]) => void;
    onDismiss: (ids: string[], undo: boolean) => void;
    onRevert: (id: string, to: number) => void;
    onOpenPage: (pageId: string) => void;
    onOpenEdit: (runId: string, pageIds: string[]) => void;
    onWriteNewPage?: (finding: BranchFinding) => void;
  };

  let { suggestions, busy, onRecommend, onDismiss, onRevert, onOpenPage, onOpenEdit, onWriteNewPage }: Props = $props();
  let chosen = $state(new Set<string>());

  const KIND_LABEL: Record<BranchFinding['kind'], string> = {
    incorrect: 'Incorrect or contradictory',
    redundant: 'Repeated',
    stale: 'Out of date',
    clarity: 'Unclear',
    depth: 'Missing detail',
    structure: 'Structure',
    operations: 'Runbook',
    placement: 'In the wrong place',
    gap: 'Missing page',
  };
  const STATE_LABEL: Record<SuggestionView['state'], string> = {
    open: 'Open',
    writing: 'Edit being written',
    'to-decide': 'Edit to decide',
    staged: 'Staged to push',
    pushed: 'Pushed',
    failed: 'Edit failed',
    rejected: 'Every change rejected',
    skipped: 'Not edited',
    done: 'Already done',
    'not-relevant': 'No longer relevant',
    dismissed: 'Dismissed',
  };
  const IN_PROGRESS = new Set<SuggestionView['state']>(['writing', 'to-decide', 'staged', 'failed']);
  const canEdit = (s: SuggestionView): boolean =>
    s.kind !== 'placement' && s.kind !== 'gap' && Object.keys(s.pageIds).length > 0;
  // A closed or failed suggestion, or one the chat reworded after its edit, can be recommended again.
  const again = (s: SuggestionView): boolean =>
    canEdit(s) &&
    s.state !== 'writing' &&
    (!!s.outdated || ['failed', 'rejected', 'skipped', 'done', 'not-relevant'].includes(s.state));
  const open = $derived(suggestions.filter((s) => s.state === 'open'));
  const inProgress = $derived(suggestions.filter((s) => IN_PROGRESS.has(s.state)));
  const closed = $derived(suggestions.filter((s) => s.state !== 'open' && !IN_PROGRESS.has(s.state)));
  const picked = $derived(open.filter((s) => chosen.has(s.id) && canEdit(s)));
  const pages = $derived([...new Set(picked.flatMap((s) => Object.keys(s.pageIds)))]);

  function toggle(id: string): void {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    chosen = next;
  }

  /** Grouped by the first page each names, so a page's suggestions are read together. */
  function byPage(list: SuggestionView[]): Array<[string, SuggestionView[]]> {
    const by = new Map<string, SuggestionView[]>();
    for (const s of list) {
      const page = s.pages[0] ?? 'No page';
      by.set(page, [...(by.get(page) ?? []), s]);
    }
    return [...by];
  }
</script>

{#snippet row(s: SuggestionView)}
  <div class={['branch-finding', `kind-${s.kind}`, `state-${s.state}`]}>
    <div class="queue-row">
      <label class="review-check">
        {#if s.state === 'open' && canEdit(s)}
          <input type="checkbox" checked={chosen.has(s.id)} onchange={() => toggle(s.id)} />
        {/if}
        <strong>{KIND_LABEL[s.kind]}</strong>
      </label>
      {#each s.pages as p, n (n)}
        {n > 0 ? ', ' : '· '}
        {#if s.pageIds[p]}
          <button class="link-btn" onclick={() => onOpenPage(s.pageIds[p])} title="Open this page">{p}</button>
        {:else}{p}{/if}
      {/each}
      <span class="queue-state state-{s.state}"
        >{STATE_LABEL[s.state]}{s.outdated ? ', from an earlier wording' : ''}</span
      >
      {#if s.runId && s.editPageIds?.length}
        <button class="link-btn" onclick={() => onOpenEdit(s.runId!, s.editPageIds!)}>
          See the edit{s.editPageIds.length > 1 ? `s (${s.editPageIds.length} pages)` : ''}
        </button>
      {/if}
      <span class="queue-spacer"></span>
      {#if again(s)}
        <button class="btn btn-secondary btn-xs" disabled={busy} onclick={() => onRecommend([s.id])}>
          <RefreshCw size={11} /> Recommend again
        </button>
      {/if}
      {#if s.state === 'dismissed'}
        <button class="btn btn-secondary btn-xs" disabled={busy} onclick={() => onDismiss([s.id], true)}
          >Bring back</button
        >
      {:else if !IN_PROGRESS.has(s.state)}
        <button
          class="icon-btn"
          title="Dismiss"
          aria-label="Dismiss"
          disabled={busy}
          onclick={() => onDismiss([s.id], false)}><X size={13} /></button
        >
      {/if}
    </div>
    <p>{s.detail}</p>
    {#if s.suggestion}<p class="branch-suggestion">→ {s.suggestion}</p>{/if}
    {#if s.why}<p class="branch-note">{s.why}</p>{/if}
    {#if s.dismissed === 'chat'}<p class="branch-note">Removed by the chat.</p>{/if}
    {#if s.history?.length}
      <details class="queue-history">
        <summary><History size={12} /> Reworded {s.history.length} time{s.history.length === 1 ? '' : 's'}</summary>
        {#each s.history as h, n (n)}
          <div class="queue-history-item">
            <span>{h.detail}{h.suggestion ? ` → ${h.suggestion}` : ''}</span>
            <button class="btn btn-secondary btn-xs" disabled={busy} onclick={() => onRevert(s.id, n)}>Use this</button>
          </div>
        {/each}
      </details>
    {/if}
    {#if s.kind === 'gap' || s.kind === 'placement'}
      <p class="branch-note">
        {s.kind === 'gap'
          ? 'This needs a new page, so it cannot be applied as an edit.'
          : 'This needs a page moved, split or merged: do it in Confluence.'}
        {#if s.kind === 'gap' && onWriteNewPage}
          <button class="btn btn-secondary btn-sm" onclick={() => onWriteNewPage(s)}>
            <FilePlus2 size={12} /> Write a new page
          </button>
        {/if}
      </p>
    {/if}
  </div>
{/snippet}

{#snippet group(list: SuggestionView[])}
  {#each byPage(list) as [page, items] (page)}
    <section class="queue-group">
      <h5>{page}</h5>
      {#each items as s (s.id)}{@render row(s)}{/each}
    </section>
  {/each}
{/snippet}

{#if suggestions.length === 0}
  <div class="empty-state">
    <Sparkles size={28} />
    <strong>No suggestions yet</strong>
    <p>
      Ask the chat to review its pages, or to turn the conversation into changes. Its suggestions are listed here, and
      you can ask it to reword, add or remove them.
    </p>
  </div>
{:else}
  <h4 class="queue-section">To recommend ({open.length})</h4>
  {#if open.length}
    <div class="queue-bar">
      <span class="branch-note" title={pages.join('\n')}>
        {picked.length} suggestion{picked.length === 1 ? '' : 's'} → {pages.length} page{pages.length === 1 ? '' : 's'},
        one edit each, read fresh from Confluence
      </span>
      <button
        class="btn btn-primary btn-sm"
        disabled={busy || picked.length === 0}
        onclick={() => {
          onRecommend(picked.map((s) => s.id));
          chosen = new Set();
        }}
      >
        <Sparkles size={13} /> Recommend changes for {picked.length}
      </button>
    </div>
    {@render group(open)}
  {:else}
    <p class="branch-note">Nothing left to recommend.</p>
  {/if}
  {#if inProgress.length}
    <h4 class="queue-section">In progress ({inProgress.length})</h4>
    {@render group(inProgress)}
  {/if}
  {#if closed.length}
    <details class="queue-closed">
      <summary class="queue-section">Closed ({closed.length})</summary>
      {@render group(closed)}
    </details>
  {/if}
{/if}
