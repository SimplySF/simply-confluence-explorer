<script lang="ts">
  import { Ban, Check, RefreshCw, RotateCcw, ShieldCheck, Upload } from '@lucide/svelte';
  import type { BranchItem, BranchRun } from '../../../src/api/types.js';
  import ChangeCard from './ChangeCard.svelte';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
  import Markdown from './ui/Markdown.svelte';
  import Segmented from './ui/Segmented.svelte';

  // The edits staged from a chat's chosen suggestions. Each page's edit is a list of changes, each
  // accepted or rejected on its own; the person may edit the text, which adds changes of their own,
  // and reset it to the AI's edit. A push checks every page first, then writes only the accepted
  // changes, each page against the version its edit was made from (ADR-024, ADR-059).
  type Props = {
    run: BranchRun;
    busy: string | null;
    onChange: (pageId: string, changeId: string, decision: 'accept' | 'reject' | 'undo') => Promise<boolean>;
    onAll: (pageId: string, decision: 'accept' | 'reject') => Promise<boolean>;
    onSaveText: (pageId: string, text: string) => Promise<boolean>;
    onReset: (pageId: string) => Promise<boolean>;
    onRedo: (pageId: string) => Promise<boolean>;
    onCheck: () => Promise<boolean>;
    onPush: () => void;
  };

  let { run, busy, onChange, onAll, onSaveText, onReset, onRedo, onCheck, onPush }: Props = $props();

  const STATUS_LABEL: Record<BranchItem['status'], string> = {
    pending: 'Waiting',
    working: 'Writing the edit…',
    proposed: 'To decide',
    accepted: 'Ready',
    rejected: 'Nothing to write',
    skipped: 'Skipped',
    failed: 'Failed',
    checked: 'Checked',
    'check-failed': 'Check found a problem',
    pushed: 'Pushed',
    'push-failed': 'Push refused',
  };
  const READY = ['accepted', 'checked', 'push-failed'];

  let selected = $state<string | null>(null);
  let view = $state<'changes' | 'edit' | 'preview'>('changes');
  let editing = $state('');
  let confirmPush = $state(false);
  let confirmReset = $state(false);
  const item = $derived(run.items.find((i) => i.pageId === selected) ?? run.items[0] ?? null);
  const ready = $derived(run.items.filter((i) => READY.includes(i.status)));
  const toDecide = $derived(run.items.filter((i) => i.status === 'proposed' && (i.changes?.length ?? 0) > 0));
  const failedCheck = $derived(run.items.filter((i) => i.status === 'check-failed'));
  const editable = $derived(
    !!item && item.proposed !== undefined && !['pushed', 'pending', 'working'].includes(item.status),
  );
  const changes = $derived(item?.changes ?? []);
  const pending = $derived(changes.filter((c) => c.decision === 'pending').length);
  const touched = $derived(
    !!item && (item.proposed !== item.suggested || Object.keys(item.decisions ?? {}).length > 0),
  );
  const summary = $derived(
    [
      `${ready.length} page${ready.length === 1 ? '' : 's'} ready`,
      toDecide.length ? `${toDecide.length} with changes to decide` : '',
      failedCheck.length ? `${failedCheck.length} with a problem` : '',
      'nothing is written until you push',
    ]
      .filter(Boolean)
      .join(' · '),
  );

  /** Saves the text being edited, so leaving the editor never loses it. */
  async function saveEdits(): Promise<boolean> {
    if (view !== 'edit' || !item || editing === item.proposed) return true;
    return onSaveText(item.pageId, editing);
  }

  async function show(next: typeof view): Promise<void> {
    if (!(await saveEdits())) return;
    if (next === 'edit') editing = item?.proposed ?? '';
    view = next;
  }

  async function choose(pageId: string): Promise<void> {
    if (!(await saveEdits())) return;
    selected = pageId;
    view = 'changes';
  }

  // Edits are saved a moment after typing stops, as well as when the editor is left.
  $effect(() => {
    if (view !== 'edit' || !item || editing === item.proposed) return;
    const text = editing;
    const pageId = item.pageId;
    const timer = setTimeout(() => void onSaveText(pageId, text), 800);
    return () => clearTimeout(timer);
  });

  async function checkThenConfirm(): Promise<void> {
    if (!(await saveEdits())) return;
    if (await onCheck()) confirmPush = true;
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
      {#if ['failed', 'check-failed', 'push-failed'].includes(item.status)}
        <button class="btn btn-secondary btn-sm" disabled={!!busy} onclick={() => onRedo(item.pageId)}>
          <RefreshCw size={13} /> Make this edit again from the current page
        </button>
      {/if}
      {#if item.guardSummary}<div class="guard-note"><ShieldCheck size={12} /> {item.guardSummary}</div>{/if}
      {#if item.fixes?.length}
        <p class="branch-note">Suggestions this edit applies:</p>
        <ul class="branch-critique">
          {#each item.fixes as f, n (n)}<li>{f.detail}{f.suggestion ? ` → ${f.suggestion}` : ''}</li>{/each}
        </ul>
      {/if}
      {#if item.changelog?.length}
        <details class="branch-note">
          <summary>What the AI says it changed</summary>
          <ul class="branch-critique">
            {#each item.changelog as c, n (n)}<li>{c}</li>{/each}
          </ul>
        </details>
      {/if}
      {#if item.critique?.length && !(item.critique.length === 1 && /^none\.?$/i.test(item.critique[0]))}
        <p class="branch-note">Not applied: {item.critique.join(' ')}</p>
      {/if}
      {#if item.proposed !== undefined}
        <div class="branch-toolbar">
          <Segmented
            label="Show"
            value={view}
            onChange={(v) => void show(v)}
            options={[
              { value: 'changes', label: `Changes (${changes.length})` },
              { value: 'edit', label: 'Edit the text', disabled: !editable },
              { value: 'preview', label: 'What will be written' },
            ]}
          />
          {#if editable}
            <button
              class="btn btn-secondary btn-sm"
              disabled={!!busy || !pending}
              onclick={() => onAll(item.pageId, 'accept')}
            >
              <Check size={13} /> Accept all
            </button>
            <button
              class="btn btn-secondary btn-sm"
              disabled={!!busy || !pending}
              onclick={() => onAll(item.pageId, 'reject')}
            >
              <Ban size={13} /> Reject all
            </button>
            <button
              class="btn btn-secondary btn-sm"
              disabled={!!busy || !touched}
              onclick={() => (confirmReset = true)}
            >
              <RotateCcw size={13} /> Reset to the AI's edit
            </button>
          {/if}
        </div>
        {#if view === 'changes'}
          {#if changes.length === 0}
            <p class="branch-note">This edit changes nothing on the page.</p>
          {:else}
            <p class="branch-note">
              {pending ? `${pending} of ${changes.length} to decide.` : 'Every change is decided.'} Only accepted changes
              are written; the rest of the page stays exactly as it is.
            </p>
            {#each changes as c (c.id)}
              <ChangeCard change={c} busy={!!busy || !editable} onDecide={(d) => void onChange(item.pageId, c.id, d)} />
            {/each}
          {/if}
        {:else if view === 'edit'}
          <textarea class="form-input branch-editor" aria-label="The edited page" bind:value={editing}></textarea>
          <p class="branch-note">
            Your edits are saved as you type and appear as changes of your own. Keep each ⟦marker⟧: it stands for a part
            of the page, such as a macro or an image, that is kept exactly as it is.
          </p>
        {:else}
          <p class="branch-note">The page as a push would leave it, with only the accepted changes.</p>
          <Markdown source={item.result ?? ''} extraClass="markdown-preview improve-preview" />
        {/if}
      {/if}
    {/if}
  </div>
</div>

<div class="review-footer">
  <span class="branch-note">{summary}</span>
  <button class="btn btn-primary" disabled={!ready.length || !!busy} onclick={checkThenConfirm}>
    {#if busy === 'check' || busy === 'push'}<RefreshCw size={14} class="spin" />{:else}<Upload size={14} />{/if}
    Check and push {ready.length}
  </button>
</div>

{#if confirmReset && item}
  <ConfirmDialog
    title="Reset {item.title} to the AI's edit?"
    onConfirm={() => {
      confirmReset = false;
      editing = item.suggested ?? '';
      void onReset(item.pageId);
    }}
    onCancel={() => (confirmReset = false)}
  >
    {#snippet confirmLabel()}<RotateCcw size={14} /> Reset{/snippet}
    <p>Your own edits to this page and every decision on its changes are discarded.</p>
  </ConfirmDialog>
{/if}

{#if confirmPush}
  <ConfirmDialog
    title={ready.length
      ? `Update ${ready.length} page${ready.length === 1 ? '' : 's'} in Confluence?`
      : 'Nothing can be pushed yet'}
    onConfirm={() => {
      confirmPush = false;
      if (ready.length) onPush();
    }}
    onCancel={() => (confirmPush = false)}
  >
    {#snippet confirmLabel()}<Upload size={14} /> Push{/snippet}
    {#if ready.length}
      <p>Each page's accepted changes are written; nothing else on the page changes.</p>
      <ul>
        {#each ready as i (i.pageId)}<li>
            {i.title}: {i.changes?.filter((c) => c.decision === 'accepted').length} accepted
          </li>{/each}
      </ul>
    {/if}
    {#if failedCheck.length}
      <p class="branch-note">Not pushed, because the check found a problem:</p>
      <ul>
        {#each failedCheck as i (i.pageId)}<li>{i.title}: {i.message}</li>{/each}
      </ul>
    {/if}
    <p class="branch-note">A page someone changed since its edit was made is refused, not overwritten.</p>
  </ConfirmDialog>
{/if}
