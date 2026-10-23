<script lang="ts">
  import { FilePlus2, History, RefreshCw, Sparkles, X } from '@lucide/svelte';
  import type { BranchFinding, SuggestionView } from '../../../src/api/types.js';
  import { canEdit, editNote, handNote } from '../support/suggestions.js';

  // The suggestions in a chat's review queue (ADR-060): those to recommend as cards grouped by page,
  // and below them, folded, those in progress, not edited, and closed. Ticked suggestions become one
  // edit for each page they name, each page read fresh from Confluence first (ADR-061). The chat
  // itself can reword, add and remove them; each earlier wording is kept and can be brought back.
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
  // How a kind is marked: red for what is wrong or missing, amber for what is thin or old, blue for shape.
  const KIND_TONE: Record<BranchFinding['kind'], 'err' | 'warn' | 'accent' | 'plain'> = {
    incorrect: 'err',
    gap: 'err',
    depth: 'warn',
    stale: 'warn',
    redundant: 'plain',
    clarity: 'accent',
    structure: 'accent',
    operations: 'accent',
    placement: 'accent',
  };
  const IN_PROGRESS = new Set<SuggestionView['state']>(['writing', 'to-decide', 'staged', 'failed']);
  // A closed or failed suggestion, or one the chat reworded after its edit, can be recommended again.
  const again = (s: SuggestionView): boolean =>
    canEdit(s) &&
    s.state !== 'writing' &&
    (!!s.outdated || ['failed', 'rejected', 'skipped', 'done', 'not-relevant'].includes(s.state));
  const open = $derived(suggestions.filter((s) => s.state === 'open'));
  const inProgress = $derived(suggestions.filter((s) => IN_PROGRESS.has(s.state)));
  // An edit that changed nothing, or could not be made, is listed with why rather than dropped.
  const notEdited = $derived(suggestions.filter((s) => s.state === 'skipped'));
  const closed = $derived(
    suggestions.filter((s) => s.state !== 'open' && s.state !== 'skipped' && !IN_PROGRESS.has(s.state)),
  );
  const picked = $derived(open.filter((s) => chosen.has(s.id) && canEdit(s)));
  const pages = $derived([...new Set(picked.flatMap((s) => Object.keys(s.pageIds)))]);
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

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
      const page = s.pages[0] ?? 'No page yet';
      by.set(page, [...(by.get(page) ?? []), s]);
    }
    return [...by];
  }
</script>

{#snippet card(s: SuggestionView)}
  {@const tickable = s.state === 'open' && canEdit(s)}
  <div class={['review-card', `state-${s.state}`, chosen.has(s.id) && tickable && 'selected']}>
    <input
      type="checkbox"
      class="review-card-check"
      checked={tickable && chosen.has(s.id)}
      disabled={!tickable}
      aria-label={tickable ? `Write an edit for: ${s.detail}` : 'This suggestion cannot become an edit'}
      title={tickable ? undefined : (editNote(s) ?? STATE_LABEL[s.state])}
      onchange={() => toggle(s.id)}
    />
    <div class="review-card-body">
      <div class="review-card-top">
        <span class="kind-badge tone-{KIND_TONE[s.kind]}">{KIND_LABEL[s.kind]}</span>
        {#if s.state !== 'open'}
          <span class="queue-state state-{s.state}"
            >{STATE_LABEL[s.state]}{s.outdated ? ', from an earlier wording' : ''}</span
          >
        {/if}
        <span class="queue-spacer"></span>
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
      <p class="review-card-detail">{s.detail}</p>
      {#if s.suggestion}<p class="branch-suggestion">→ {s.suggestion}</p>{/if}
      {#if s.pages.length > 1}
        <p class="branch-note">
          Also on
          {#each s.pages.slice(1) as p, n (n)}
            {n > 0 ? ', ' : ''}
            {#if s.pageIds[p]}
              <button class="link-btn" onclick={() => onOpenPage(s.pageIds[p])} title="Open this page">{p}</button>
            {:else}{p}{/if}
          {/each}
        </p>
      {/if}
      {#if handNote(s)}<p class="branch-note">{handNote(s)}</p>{/if}
      {#if s.why}<p class="branch-note">{s.why}</p>{/if}
      {#if s.dismissed === 'chat'}<p class="branch-note">Removed by the chat.</p>{/if}
      {#if s.runId && s.editPageIds?.length}
        <button class="link-btn" onclick={() => onOpenEdit(s.runId!, s.editPageIds!)}>
          See the edit{s.editPageIds.length > 1 ? `s (${s.editPageIds.length} pages)` : ''}
        </button>
      {/if}
      {#if again(s)}
        <button class="btn btn-secondary btn-xs" disabled={busy} onclick={() => onRecommend([s.id])}>
          <RefreshCw size={11} /> Recommend again
        </button>
      {/if}
      {#if s.history?.length}
        <details class="queue-history">
          <summary><History size={12} /> Reworded {s.history.length} time{s.history.length === 1 ? '' : 's'}</summary>
          {#each s.history as h, n (n)}
            <div class="queue-history-item">
              <span>{h.detail}{h.suggestion ? ` → ${h.suggestion}` : ''}</span>
              <button class="btn btn-secondary btn-xs" disabled={busy} onclick={() => onRevert(s.id, n)}
                >Use this</button
              >
            </div>
          {/each}
        </details>
      {/if}
      {#if s.state === 'open' && editNote(s)}
        <div class="review-card-note">
          <p class="branch-note">{editNote(s)}</p>
          {#if s.kind === 'gap' && onWriteNewPage}
            <button class="btn btn-secondary btn-xs" onclick={() => onWriteNewPage(s)}>
              <FilePlus2 size={12} /> Write new page
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet group(list: SuggestionView[])}
  {#each byPage(list) as [page, items] (page)}
    {@const id = items[0].pageIds[page]}
    <section class="queue-group">
      <h5>
        {#if id}<button class="link-btn" onclick={() => onOpenPage(id)} title="Open this page">{page}</button
          >{:else}{page}{/if}
      </h5>
      {#each items as s (s.id)}{@render card(s)}{/each}
    </section>
  {/each}
{/snippet}

{#if suggestions.length === 0}
  <div class="empty-state review-empty">
    <Sparkles size={24} />
    <strong>No suggestions yet</strong>
    <p>
      Ask the chat to review its pages, or choose Add from chat once it has found something. Its suggestions are listed
      here, and you can ask it to reword, add or remove them.
    </p>
  </div>
{:else}
  <div class="review-list">
    {#if open.length}
      {@render group(open)}
    {:else}
      <p class="branch-note">Nothing left to recommend.</p>
    {/if}
    {#if inProgress.length || notEdited.length || closed.length}
      <div class="review-more">
        {#if inProgress.length}
          <details class="queue-closed">
            <summary>In progress ({inProgress.length})</summary>
            {@render group(inProgress)}
          </details>
        {/if}
        {#if notEdited.length}
          <details class="queue-closed" open>
            <summary>Not edited ({notEdited.length})</summary>
            {@render group(notEdited)}
          </details>
        {/if}
        {#if closed.length}
          <details class="queue-closed">
            <summary>Closed and dismissed ({closed.length})</summary>
            {@render group(closed)}
          </details>
        {/if}
      </div>
    {/if}
  </div>
  {#if open.length}
    <div class="review-footer-bar">
      <p class="branch-note" title={pages.join('\n')}>
        {plural(picked.length, 'suggestion')} → {plural(pages.length, 'page')}. Each page is read fresh from Confluence,
        then edited.
      </p>
      <button
        class="btn btn-primary review-write"
        disabled={busy || picked.length === 0}
        onclick={() => {
          onRecommend(picked.map((s) => s.id));
          chosen = new Set();
        }}
      >
        <Sparkles size={14} /> Write edits for {plural(pages.length, 'page')}
      </button>
    </div>
  {/if}
{/if}
