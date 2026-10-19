<script lang="ts">
  import { Ban, Check, RefreshCw, RotateCcw, ShieldCheck, Upload } from '@lucide/svelte';
  import type { BranchItem, BranchRun } from '../../../src/api/types.js';
  import { bodyOf } from '../support/markdown.js';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
  import Diff from './ui/Diff.svelte';
  import Markdown from './ui/Markdown.svelte';
  import Segmented from './ui/Segmented.svelte';

  // The edits staged from a review's chosen suggestions: each page is read, then accepted (with or
  // without the person's own changes) or rejected. Only accepted pages are checked and pushed, each
  // against the version its edit was made from (ADR-024).
  type Props = {
    run: BranchRun;
    busy: string | null;
    onDecide: (pageId: string, decision: 'accept' | 'reject' | 'reset', edited?: string) => Promise<boolean>;
    onCheck: () => void;
    onPush: () => void;
  };

  let { run, busy, onDecide, onCheck, onPush }: Props = $props();

  const STATUS_LABEL: Record<BranchItem['status'], string> = {
    pending: 'Waiting',
    working: 'Writing the edit…',
    proposed: 'To review',
    accepted: 'Accepted',
    rejected: 'Rejected',
    skipped: 'Skipped',
    failed: 'Failed',
    checked: 'Dry run passed',
    'check-failed': 'Dry run failed',
    pushed: 'Pushed',
    'push-failed': 'Push refused',
  };

  let selected = $state<string | null>(null);
  let view = $state<'diff' | 'edit' | 'preview'>('diff');
  let editing = $state('');
  let confirmPush = $state(false);
  const item = $derived(run.items.find((i) => i.pageId === selected) ?? run.items[0] ?? null);
  const accepted = $derived(run.items.filter((i) => ['accepted', 'checked', 'push-failed'].includes(i.status)));
  const decidable = $derived(!!item?.proposed && !['pushed', 'pending', 'working'].includes(item.status));

  function choose(pageId: string): void {
    selected = pageId;
    view = 'diff';
  }

  async function decide(decision: 'accept' | 'reject' | 'reset'): Promise<void> {
    if (!item) return;
    const edited = decision === 'accept' && view === 'edit' ? editing : undefined;
    if (await onDecide(item.pageId, decision, edited)) view = 'diff';
  }
</script>

<div class="branch-queue">
  <ul class="branch-items">
    {#each run.items as i (i.pageId)}
      <li class={{ selected: i.pageId === item?.pageId }}>
        <button type="button" class="branch-item-button" onclick={() => choose(i.pageId)}>
          <span>{i.title}</span>
          <span class="branch-status status-{i.status}">{STATUS_LABEL[i.status]}</span>
        </button>
      </li>
    {/each}
  </ul>
  <div class="branch-detail">
    {#if !item}
      <p class="branch-note">Choose a page to see its edit.</p>
    {:else}
      <h4>{item.title}</h4>
      {#if item.message}<div class="branch-error">{item.message}</div>{/if}
      {#if item.guardSummary}<div class="guard-note"><ShieldCheck size={12} /> {item.guardSummary}</div>{/if}
      {#if item.fixes?.length}
        <ul class="branch-critique">
          {#each item.fixes as f, n (n)}<li>{f.detail}{f.suggestion ? ` → ${f.suggestion}` : ''}</li>{/each}
        </ul>
      {/if}
      {#if item.critique?.length && !(item.critique.length === 1 && /^none\.?$/i.test(item.critique[0]))}
        <p class="branch-note">Not applied: {item.critique.join(' ')}</p>
      {/if}
      {#if item.proposed}
        <Segmented
          label="Edit"
          value={view}
          onChange={(v) => {
            if (v === 'edit') editing = item.proposed ?? '';
            view = v;
          }}
          options={[
            { value: 'diff', label: 'Changes' },
            { value: 'edit', label: 'Edit' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
        {#if view === 'diff'}
          <Diff before={bodyOf(item.original ?? '')} after={item.proposed} />
        {:else if view === 'edit'}
          <textarea class="form-input branch-editor" aria-label="The edited page" bind:value={editing}></textarea>
        {:else}
          <Markdown source={item.proposed} extraClass="markdown-preview improve-preview" />
        {/if}
      {/if}
      {#if decidable}
        <div class="branch-actions">
          <button class="btn btn-primary btn-sm" disabled={!!busy} onclick={() => decide('accept')}>
            <Check size={13} />
            {view === 'edit' ? 'Accept with my edits' : 'Accept'}
          </button>
          <button class="btn btn-secondary btn-sm" disabled={!!busy} onclick={() => decide('reject')}>
            <Ban size={13} /> Reject
          </button>
          {#if item.status !== 'proposed'}
            <button class="btn btn-secondary btn-sm" disabled={!!busy} onclick={() => decide('reset')}>
              <RotateCcw size={13} /> Undecide
            </button>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</div>

<div class="review-footer">
  <span class="branch-note">{accepted.length} accepted · nothing is written until you push</span>
  <button class="btn btn-secondary" disabled={!accepted.length || !!busy} onclick={onCheck}>
    {#if busy === 'check'}<RefreshCw size={14} class="spin" />{:else}<Check size={14} />{/if} Dry run accepted
  </button>
  <button class="btn btn-primary" disabled={!accepted.length || !!busy} onclick={() => (confirmPush = true)}>
    {#if busy === 'push'}<RefreshCw size={14} class="spin" />{:else}<Upload size={14} />{/if} Push {accepted.length} to Confluence
  </button>
</div>

{#if confirmPush}
  <ConfirmDialog
    title="Update {accepted.length} page{accepted.length === 1 ? '' : 's'} in Confluence?"
    onConfirm={() => {
      confirmPush = false;
      onPush();
    }}
    onCancel={() => (confirmPush = false)}
  >
    {#snippet confirmLabel()}<Upload size={14} /> Push{/snippet}
    <ul>
      {#each accepted as i (i.pageId)}<li>{i.title}</li>{/each}
    </ul>
    <p class="branch-note">
      Each page is checked first: one that someone changed since its edit was made is refused, not overwritten.
    </p>
  </ConfirmDialog>
{/if}
