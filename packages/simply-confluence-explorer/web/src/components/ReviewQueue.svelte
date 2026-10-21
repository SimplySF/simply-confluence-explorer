<script lang="ts">
  import { Eye, EyeOff, FilePlus2, History, Sparkles, X } from '@lucide/svelte';
  import type { BranchFinding, SuggestionView } from '../../../src/api/types.js';

  // A chat's review queue (ADR-060): its suggestions grouped by page, each with its state. Ticked
  // suggestions become edits, each page read fresh from Confluence first (ADR-061). The chat itself
  // can reword, add and remove them; each earlier wording is kept and can be brought back.
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
  let showDismissed = $state(false);

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
    dismissed: 'Dismissed',
    editing: 'Edit being written',
    edited: 'Edit recommended',
    done: 'Already done',
    'not-relevant': 'No longer relevant',
    skipped: 'Not edited',
  };
  const editable = (s: SuggestionView): boolean =>
    s.kind !== 'placement' && s.kind !== 'gap' && Object.keys(s.pageIds).length > 0 && s.state !== 'dismissed';
  const shown = $derived(suggestions.filter((s) => showDismissed || s.state !== 'dismissed'));
  const dismissed = $derived(suggestions.filter((s) => s.state === 'dismissed').length);
  // Grouped by the first page each names, so a page's suggestions are read together.
  const groups = $derived.by(() => {
    const by = new Map<string, SuggestionView[]>();
    for (const s of shown) {
      const page = s.pages[0] ?? 'No page';
      by.set(page, [...(by.get(page) ?? []), s]);
    }
    return [...by];
  });
  const picked = $derived([...chosen].filter((id) => suggestions.some((s) => s.id === id && editable(s))));

  function toggle(id: string): void {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    chosen = next;
  }
</script>

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
  <div class="queue-bar">
    <span class="branch-note"
      >{picked.length} chosen · each page they name gets one edit, read fresh from Confluence</span
    >
    {#if dismissed}
      <button class="btn btn-secondary btn-sm" onclick={() => (showDismissed = !showDismissed)}>
        {#if showDismissed}<EyeOff size={13} /> Hide dismissed{:else}<Eye size={13} /> Show dismissed ({dismissed}){/if}
      </button>
    {/if}
    <button
      class="btn btn-primary btn-sm"
      disabled={busy || picked.length === 0}
      onclick={() => {
        onRecommend(picked);
        chosen = new Set();
      }}
    >
      <Sparkles size={13} /> Recommend changes for {picked.length}
    </button>
  </div>
  {#each groups as [page, list] (page)}
    <section class="queue-group">
      <h4>{page}</h4>
      {#each list as s (s.id)}
        <div class={['branch-finding', `kind-${s.kind}`, `state-${s.state}`]}>
          <div class="queue-row">
            <label class="review-check">
              {#if editable(s)}
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
            {#if s.runId}
              <button class="link-btn" onclick={() => onOpenEdit(s.runId!, Object.values(s.pageIds))}
                >See the edit</button
              >
            {/if}
            <span class="queue-spacer"></span>
            {#if s.state === 'dismissed'}
              <button class="btn btn-secondary btn-xs" disabled={busy} onclick={() => onDismiss([s.id], true)}
                >Bring back</button
              >
            {:else}
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
              <summary
                ><History size={12} /> Reworded {s.history.length} time{s.history.length === 1 ? '' : 's'}</summary
              >
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
      {/each}
    </section>
  {/each}
{/if}
