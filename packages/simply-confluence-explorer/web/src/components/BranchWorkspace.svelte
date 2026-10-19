<script lang="ts">
  import { Ban, Check, FolderTree, RefreshCw, RotateCcw, Search, ShieldCheck, Upload, Wand2 } from '@lucide/svelte';
  import type { BranchItem, BranchRun } from '../../../src/api/types.js';
  import { branches, type BranchRunSummary } from '../support/api.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { bodyOf } from '../support/markdown.js';
  import { messageOf } from '../support/toast.svelte.js';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
  import Dialog from './ui/Dialog.svelte';
  import Diff from './ui/Diff.svelte';
  import JobProgress from './ui/JobProgress.svelte';

  // Work on a section, a page and everything under it: review it as a whole, or improve each page through
  // a queue where nothing is written until it is accepted (ADR-024).
  type Props = {
    spaceKey: string;
    pageId: string;
    title: string;
    descendantCount: number;
    onClose: () => void;
    /** Called after pages were written, so the tree and page reload. */
    onPushed: () => void;
    /** A page named in a finding was chosen. */
    onOpenPage: (pageId: string) => void;
  };

  let { spaceKey, pageId, title, descendantCount, onClose, onPushed, onOpenPage }: Props = $props();

  const FOCUSES = [
    { id: 'polish', label: 'Polish: clarity and tone' },
    { id: 'completeness', label: 'Completeness: missing steps and context' },
    { id: 'structure', label: 'Structure: headings, code blocks, panels' },
    { id: 'runbook', label: 'Runbook: pre-checks, rollback, verification' },
  ];
  const KIND_LABEL: Record<string, string> = {
    incorrect: 'Incorrect or contradictory',
    redundant: 'Redundant',
    stale: 'Out of date',
    structure: 'Structure',
    gap: 'Missing',
  };
  const STATUS_LABEL: Record<BranchItem['status'], string> = {
    pending: 'Waiting',
    working: 'Writing proposal…',
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

  let run = $state<BranchRun | null>(null);
  let history = $state<BranchRunSummary[]>([]);
  let focus = $state('polish');
  let instructions = $state('');
  let selected = $state<string | null>(null);
  let editing = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let confirmPush = $state(false);

  $effect(() => {
    branches.list(spaceKey, pageId).then(
      (h) => (history = h),
      (e: unknown) => (error = messageOf(e)),
    );
  });

  // A run still going, or the one the header asked for, opens straight away.
  $effect(() => {
    const wanted = jobs.requested?.rootPageId === pageId ? jobs.requested : jobs.review(spaceKey, pageId);
    if (!wanted || run) return;
    jobs.requested = null;
    void act('open', () => branches.get(wanted.jobId));
  });

  // The header follows a running run, so closing this dialog does not lose sight of it.
  $effect(() => {
    if (run?.status === 'running') jobs.watchReview(run);
  });

  // Proposals arrive one page at a time, so a running run is read again every second until it is ready.
  $effect(() => {
    const id = run?.id;
    if (!id || run?.status !== 'running') return;
    const timer = setInterval(() => {
      branches.get(id).then(
        (r) => (run = r),
        (e: unknown) => (error = messageOf(e)),
      );
    }, 1000);
    return () => clearInterval(timer);
  });

  async function act(label: string, fn: () => Promise<BranchRun>): Promise<boolean> {
    busy = label;
    error = null;
    try {
      run = await fn();
      return true;
    } catch (e) {
      error = messageOf(e);
      return false;
    } finally {
      busy = null;
    }
  }

  const start = (kind: 'review' | 'improve'): Promise<boolean> =>
    act(kind, () =>
      branches.start({
        kind,
        spaceKey,
        pageId,
        focus: kind === 'improve' ? focus : undefined,
        instructions: instructions.trim() || undefined,
      }),
    );

  const item = $derived(run?.items.find((i) => i.pageId === selected) ?? null);
  const accepted = $derived(run?.items.filter((i) => ['accepted', 'checked', 'push-failed'].includes(i.status)) ?? []);

  async function decide(decision: 'accept' | 'reject' | 'reset'): Promise<void> {
    if (!run || !item) return;
    const { id } = run;
    const target = item.pageId;
    const edited = decision === 'accept' ? (editing ?? undefined) : undefined;
    if (await act(decision, () => branches.decide(id, target, decision, edited))) editing = null;
  }

  async function push(): Promise<void> {
    confirmPush = false;
    if (!run) return;
    const { id } = run;
    await act('push', () => branches.push(id));
    onPushed();
  }
</script>

{#snippet improveFooter()}
  <span class="branch-note">{accepted.length} accepted · nothing is written until you push</span>
  <button
    class="btn btn-secondary"
    disabled={!accepted.length || !!busy}
    onclick={() => run && act('check', () => branches.check(run!.id))}
  >
    {#if busy === 'check'}<RefreshCw size={14} class="spin" />{:else}<Check size={14} />{/if} Dry run accepted
  </button>
  <button class="btn btn-primary" disabled={!accepted.length || !!busy} onclick={() => (confirmPush = true)}>
    {#if busy === 'push'}<RefreshCw size={14} class="spin" />{:else}<Upload size={14} />{/if} Push {accepted.length} to Confluence
  </button>
{/snippet}

<Dialog size="branch-workspace" {onClose} footer={run?.kind === 'improve' ? improveFooter : undefined}>
  {#snippet header()}
    <FolderTree size={16} />
    {title} and {descendantCount} page{descendantCount === 1 ? '' : 's'} under it
  {/snippet}
  {#if error}<div class="branch-error">{error}</div>{/if}

  {#if !run}
    <div class="branch-start">
      <section>
        <h4><Search size={14} /> Review this section</h4>
        <p>
          One read of every page together: what is wrong, repeated, out of date, misplaced or missing. Nothing is
          changed.
        </p>
        <button class="btn btn-primary btn-sm" disabled={!!busy} onclick={() => start('review')}>
          {#if busy === 'review'}<RefreshCw size={13} class="spin" /> Collecting pages…{:else}<Search size={13} /> Review{/if}
        </button>
      </section>
      <section>
        <h4><Wand2 size={14} /> Improve every page</h4>
        <p>
          A proposal for each page, for you to accept, edit or reject. Only accepted pages are ever written to
          Confluence.
        </p>
        <select class="form-input" bind:value={focus} aria-label="Focus">
          {#each FOCUSES as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
        </select>
        <button class="btn btn-primary btn-sm" disabled={!!busy} onclick={() => start('improve')}>
          {#if busy === 'improve'}<RefreshCw size={13} class="spin" /> Collecting pages…{:else}<Wand2 size={13} /> Start proposals{/if}
        </button>
      </section>
    </div>
    <textarea
      class="form-input"
      rows="2"
      aria-label="Anything to focus on"
      placeholder="Anything to focus on (optional), e.g. “we moved from Jenkins to GitLab CI in 2025”"
      bind:value={instructions}
    ></textarea>
    {#if history.length > 0}
      <div class="branch-history">
        <h4>Earlier runs on this section</h4>
        {#each history as h (h.id)}
          <button class="branch-history-row" onclick={() => act('open', () => branches.get(h.id))}>
            {h.kind === 'review' ? 'Review' : `Improve (${h.focus})`} · {new Date(h.createdAt).toLocaleString()} · {h.status}
          </button>
        {/each}
      </div>
    {/if}
  {:else}
    <div class="branch-runbar">
      {#if run.status === 'running'}
        <JobProgress
          processed={run.processed}
          total={run.kind === 'review' ? 0 : run.total}
          current={run.kind === 'review'
            ? `Reading ${Object.keys(run.pageIds ?? {}).length} pages with the AI`
            : run.items.find((i) => i.status === 'working')?.title}
          startedAt={run.createdAt}
          onStop={() => run && act('cancel', () => branches.cancel(run!.id))}
        />
      {:else}
        <span>{run.kind === 'review' ? 'Review' : 'Improve'} · {run.status}</span>
      {/if}
      <button class="btn btn-secondary btn-sm" onclick={() => (run = null)}>Back</button>
    </div>
    {#if run.leftOut.length > 0}<div class="branch-note">Left out: {run.leftOut.join(', ')}.</div>{/if}
    {#if run.error}<div class="branch-error">{run.error}</div>{/if}

    {#if run.kind === 'review' && run.status !== 'running'}
      <div class="branch-findings">
        {#if run.findings?.length === 0}<p>No problems found.</p>{/if}
        {#each run.findings ?? [] as f, i (i)}
          <div class="branch-finding kind-{f.kind}">
            <strong>{KIND_LABEL[f.kind]}</strong> ·
            {#each f.pages as p, n (n)}
              {n > 0 ? ', ' : ''}
              {#if run.pageIds?.[p]}
                <button class="link-btn" onclick={() => onOpenPage(run!.pageIds![p])} title="Open this page">{p}</button
                >
              {:else}
                {p}
              {/if}
            {/each}
            <p>{f.detail}</p>
            {#if f.suggestion}<p class="branch-suggestion">→ {f.suggestion}</p>{/if}
          </div>
        {/each}
        {#if run.reportText}<pre class="branch-report">{run.reportText}</pre>{/if}
      </div>
    {/if}

    {#if run.kind === 'improve'}
      <div class="branch-queue">
        <ul class="branch-items">
          {#each run.items as i (i.pageId)}
            <li class={{ selected: i.pageId === selected }}>
              <button
                type="button"
                class="branch-item-button"
                onclick={() => {
                  selected = i.pageId;
                  editing = null;
                }}
              >
                <span>{i.title}</span>
                <span class="branch-status status-{i.status}">{STATUS_LABEL[i.status]}</span>
              </button>
            </li>
          {/each}
        </ul>
        <div class="branch-detail">
          {#if !item}
            <p class="branch-note">Choose a page to see its proposal.</p>
          {:else}
            <h4>{item.title}</h4>
            {#if item.message}<div class="branch-error">{item.message}</div>{/if}
            {#if item.guardSummary}<div class="guard-note"><ShieldCheck size={12} /> {item.guardSummary}</div>{/if}
            {#if item.critique?.length}
              <ul class="branch-critique">
                {#each item.critique as c, n (n)}<li>{c}</li>{/each}
              </ul>
            {/if}
            {#if item.proposed && editing === null}
              <Diff before={bodyOf(item.original ?? '')} after={item.proposed} />
            {/if}
            {#if editing !== null}<textarea class="form-input branch-editor" bind:value={editing}></textarea>{/if}
            {#if item.proposed && !['pushed', 'pending', 'working'].includes(item.status)}
              <div class="branch-actions">
                {#if editing === null}
                  <button class="btn btn-secondary btn-sm" onclick={() => (editing = item.proposed ?? '')}>Edit</button>
                {:else}
                  <button class="btn btn-secondary btn-sm" onclick={() => (editing = null)}>Discard edits</button>
                {/if}
                <button class="btn btn-primary btn-sm" disabled={!!busy} onclick={() => decide('accept')}>
                  <Check size={13} />
                  {editing !== null ? 'Accept with my edits' : 'Accept'}
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
    {/if}
  {/if}

  {#if confirmPush && run}
    <ConfirmDialog
      title="Update {accepted.length} page{accepted.length === 1 ? '' : 's'} in Confluence?"
      onConfirm={push}
      onCancel={() => (confirmPush = false)}
    >
      {#snippet confirmLabel()}<Upload size={14} /> Push{/snippet}
      <ul>
        {#each accepted as i (i.pageId)}<li>{i.title}</li>{/each}
      </ul>
      <p class="branch-note">
        Each page is checked first: one that someone changed since its proposal is refused, not overwritten.
      </p>
    </ConfirmDialog>
  {/if}
</Dialog>
