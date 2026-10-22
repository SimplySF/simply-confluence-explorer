<script lang="ts">
  import {
    ArrowLeft,
    Ban,
    Check,
    MessageSquare,
    PackageCheck,
    PackageMinus,
    RefreshCw,
    RotateCcw,
    ShieldCheck,
    X,
  } from '@lucide/svelte';
  import type { BranchItem, BranchRun } from '../../../src/api/types.js';
  import { bodyOf } from '../support/markdown.js';
  import ChangeCard from './ChangeCard.svelte';
  import ImagesNote from './ImagesNote.svelte';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
  import Diff from './ui/Diff.svelte';
  import Markdown from './ui/Markdown.svelte';
  import Segmented from './ui/Segmented.svelte';

  // One page's edit (ADR-059, ADR-060): the page and the edit side by side, each change decided
  // between them, the AI's recommendation beside it, and the chat to ask for a revision. Once every
  // change is decided, the page is staged for the push queue.
  type Props = {
    run: BranchRun;
    item: BranchItem;
    busy: string | null;
    onBack: () => void;
    onChange: (changeId: string, decision: 'accept' | 'reject' | 'undo') => Promise<boolean>;
    onAll: (decision: 'accept' | 'reject') => Promise<boolean>;
    onSaveText: (text: string) => Promise<boolean>;
    onReset: () => Promise<boolean>;
    onRedo: () => Promise<boolean>;
    onStage: (staged: boolean) => Promise<boolean>;
    /** A revision the chat proposed for this edit and the person has not decided yet. */
    proposal: { turn: number; text: string } | null;
    onProposal: (turn: number, accept: boolean) => void;
    /** The chat's next message is about this edit. */
    focused: boolean;
    onRefine: () => void;
    /** The chat's newest answer, shown while it works on this edit. */
    lastAnswer?: string;
  };

  let {
    run,
    item,
    busy,
    onBack,
    onChange,
    onAll,
    onSaveText,
    onReset,
    onRedo,
    onStage,
    proposal,
    onProposal,
    focused,
    onRefine,
    lastAnswer,
  }: Props = $props();

  const STATUS: Partial<Record<BranchItem['status'], string>> = {
    pending: 'Waiting',
    checking: 'Reading the page from Confluence',
    working: 'Writing the edit',
    proposed: 'To decide',
    accepted: 'Ready to stage',
    rejected: 'Every change rejected',
    skipped: 'Not edited',
    failed: 'Failed',
    checked: 'Checked',
    'check-failed': 'Check found a problem',
    pushed: 'Pushed',
    'push-failed': 'Push refused',
  };
  const READY = ['accepted', 'checked', 'push-failed'];

  let view = $state<'side' | 'edit' | 'result'>('side');
  let editing = $state('');
  let confirmReset = $state(false);
  const changes = $derived(item.changes ?? []);
  const byId = $derived(new Map(changes.map((c) => [c.id, c])));
  const pending = $derived(changes.filter((c) => c.decision === 'pending').length);
  const editable = $derived(
    item.proposed !== undefined && !['pushed', 'pending', 'checking', 'working'].includes(item.status),
  );
  const touched = $derived(item.proposed !== item.suggested || Object.keys(item.decisions ?? {}).length > 0);
  const dropped = $derived((item.freshness?.verdicts ?? []).filter((v) => v.verdict !== 'applies'));

  async function saveEdits(): Promise<boolean> {
    if (view !== 'edit' || editing === item.proposed) return true;
    return onSaveText(editing);
  }

  async function show(next: typeof view): Promise<void> {
    if (!(await saveEdits())) return;
    if (next === 'edit') editing = item.proposed ?? '';
    view = next;
  }

  // Edits are saved a moment after typing stops, as well as when the editor is left.
  $effect(() => {
    if (view !== 'edit' || editing === item.proposed) return;
    const text = editing;
    const timer = setTimeout(() => void onSaveText(text), 800);
    return () => clearTimeout(timer);
  });
</script>

<div class="edit-view">
  <div class="edit-head">
    <button class="btn btn-secondary btn-sm" onclick={() => void saveEdits().then(onBack)}>
      <ArrowLeft size={13} /> All changes
    </button>
    <h4>{item.title}</h4>
    <span class="branch-status status-{item.status}">{item.staged ? 'Staged' : STATUS[item.status]}</span>
  </div>
  {#if item.message}<div class="branch-error">{item.message}</div>{/if}
  {#if ['failed', 'check-failed', 'push-failed'].includes(item.status)}
    <button class="btn btn-secondary btn-sm" disabled={!!busy || run.status === 'running'} onclick={onRedo}>
      <RefreshCw size={13} /> Make this edit again from the current page
    </button>
  {/if}

  <div class="edit-body">
    <div class="edit-main">
      {#if proposal}
        <div class="chat-proposal">
          <strong>The chat proposed a revision of this edit</strong>
          <Diff before={item.proposed ?? ''} after={proposal.text} />
          <div class="branch-actions">
            <button class="btn btn-primary btn-sm" disabled={!!busy} onclick={() => onProposal(proposal.turn, true)}>
              <Check size={13} /> Accept into the edit
            </button>
            <button class="btn btn-secondary btn-sm" disabled={!!busy} onclick={() => onProposal(proposal.turn, false)}>
              <X size={13} /> Dismiss
            </button>
          </div>
        </div>
      {/if}
      {#if item.proposed === undefined && ['pending', 'checking', 'working'].includes(item.status)}
        <div class="edit-progress">
          <strong>This edit is being written</strong>
          <p class="branch-note">It opens here for you to decide as soon as it is ready.</p>
          <ol class="edit-steps">
            {#each item.steps ?? [] as s, n (n)}
              <li>
                <span class="muted"
                  >{new Date(s.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}</span
                >
                {s.text}
              </li>
            {:else}<li>Waiting for a free request to the AI.</li>{/each}
          </ol>
          {#if item.writing}
            <p class="branch-note">The answer so far, {item.writing.chars.toLocaleString()} characters; its end:</p>
            <pre class="edit-writing">{item.writing.tail}</pre>
          {/if}
        </div>
      {/if}
      {#if item.proposed !== undefined}
        <div class="branch-toolbar">
          <Segmented
            label="Show"
            value={view}
            onChange={(v) => void show(v)}
            options={[
              { value: 'side', label: `Side by side (${changes.length})` },
              { value: 'edit', label: 'Edit the text', disabled: !editable },
              { value: 'result', label: 'What will be written' },
            ]}
          />
          {#if editable}
            <button class="btn btn-secondary btn-sm" disabled={!!busy || !pending} onclick={() => onAll('accept')}>
              <Check size={13} /> Accept all
            </button>
            <button class="btn btn-secondary btn-sm" disabled={!!busy || !pending} onclick={() => onAll('reject')}>
              <Ban size={13} /> Reject all
            </button>
            <button
              class="btn btn-secondary btn-sm"
              disabled={!!busy || !touched}
              onclick={() => (confirmReset = true)}
            >
              <RotateCcw size={13} /> Reset to the AI's edit
            </button>
            {#if item.staged}
              <button class="btn btn-secondary btn-sm" disabled={!!busy} onclick={() => onStage(false)}>
                <PackageMinus size={13} /> Unstage
              </button>
            {:else}
              <button
                class="btn btn-primary btn-sm"
                disabled={!!busy || !READY.includes(item.status)}
                title={READY.includes(item.status) ? 'Add this page to the push queue' : 'Decide every change first'}
                onclick={() => onStage(true)}
              >
                <PackageCheck size={13} /> Stage
              </button>
            {/if}
          {/if}
        </div>
        {#if view === 'side'}
          <p class="branch-note">
            {pending ? `${pending} of ${changes.length} to decide.` : 'Every change is decided.'} The page as it is now is
            on the left, the edit on the right. Only accepted changes are written.
          </p>
          {#if item.rows}
            <div class="side-by-side">
              <div class="side-head"><span>The page now</span><span></span><span>The edit</span></div>
              {#each item.rows as row, n (n)}
                {#if 'same' in row}
                  <div class="side-same">
                    <Markdown source={row.same} extraClass="markdown-preview side-cell" />
                    <span></span>
                    <Markdown source={row.same} extraClass="markdown-preview side-cell" />
                  </div>
                {:else if byId.get(row.change)}
                  {@const c = byId.get(row.change)!}
                  <ChangeCard columns change={c} busy={!!busy || !editable} onDecide={(d) => void onChange(c.id, d)} />
                {/if}
              {/each}
            </div>
          {:else}
            {#each changes as c (c.id)}
              <ChangeCard change={c} busy={!!busy || !editable} onDecide={(d) => void onChange(c.id, d)} />
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
          <Markdown source={bodyOf(item.result ?? '')} extraClass="markdown-preview improve-preview" />
        {/if}
      {/if}
    </div>

    <aside class="edit-side">
      <h5>The AI's recommendation</h5>
      {#if item.guardSummary}<div class="guard-note"><ShieldCheck size={12} /> {item.guardSummary}</div>{/if}
      {#if item.images}<ImagesNote spaceKey={run.spaceKey} report={item.images} />{/if}
      {#if item.fixes?.length}
        <p class="branch-note">Suggestions this edit applies:</p>
        <ul class="branch-critique">
          {#each item.fixes as f, n (n)}<li>{f.detail}{f.suggestion ? ` → ${f.suggestion}` : ''}</li>{/each}
        </ul>
      {/if}
      {#if item.fixes?.some((f) => f.byHand)}
        <p class="branch-note">To do in Confluence, which no edit can change:</p>
        <ul class="branch-critique">
          {#each item.fixes.filter((f) => f.byHand) as f, n (n)}<li>{f.byHand}</li>{/each}
        </ul>
      {/if}
      {#if dropped.length}
        <p class="branch-note">Not applied, because the page changed since they were suggested:</p>
        <ul class="branch-critique">
          {#each dropped as v, n (n)}
            <li>
              {v.detail}: {v.verdict === 'done' ? 'already done' : 'no longer relevant'}{v.why ? `. ${v.why}` : ''}
            </li>
          {/each}
        </ul>
      {/if}
      {#if item.changelog?.length}
        <p class="branch-note">What the AI says it changed:</p>
        <ul class="branch-critique">
          {#each item.changelog as c, n (n)}<li>{c}</li>{/each}
        </ul>
      {/if}
      {#if item.critique?.length && !(item.critique.length === 1 && /^none\.?$/i.test(item.critique[0]))}
        <p class="branch-note">Not applied: {item.critique.join(' ')}</p>
      {/if}
      {#if item.steps?.length && item.proposed !== undefined}
        <details class="branch-note">
          <summary>How this edit was made</summary>
          <ol class="edit-steps">
            {#each item.steps as s, n (n)}<li>{s.text}</li>{/each}
          </ol>
        </details>
      {/if}
      <h5>Refine with the chat</h5>
      {#if focused}
        <p class="branch-note">The message box below is working on this edit. Ask for a change, such as "shorter".</p>
        {#if lastAnswer}<Markdown source={lastAnswer} extraClass="ai-response-rendered edit-answer" />{/if}
      {:else}
        <button class="btn btn-secondary btn-sm" disabled={!editable} onclick={onRefine}>
          <MessageSquare size={13} /> Work on this edit in the chat
        </button>
      {/if}
    </aside>
  </div>
</div>

{#if confirmReset}
  <ConfirmDialog
    title="Reset {item.title} to the AI's edit?"
    onConfirm={() => {
      confirmReset = false;
      editing = item.suggested ?? '';
      void onReset();
    }}
    onCancel={() => (confirmReset = false)}
  >
    {#snippet confirmLabel()}<RotateCcw size={14} /> Reset{/snippet}
    <p>
      Your own edits to this page, accepted revisions from the chat, and every decision on its changes are discarded.
    </p>
  </ConfirmDialog>
{/if}
