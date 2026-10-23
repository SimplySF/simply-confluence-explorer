<script lang="ts">
  import { ArrowLeft, FileText, PackageCheck, PackageMinus, Upload } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { BranchFinding, BranchItem, BranchRun, ChatQueue } from '../../../src/api/types.js';
  import { branches, sessions, type Focus } from '../support/api.js';
  import type { AiChat } from '../support/chat.svelte.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { reviewCounts, STEPS, stepOf, type Step } from '../support/review.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ChatThread from './ChatThread.svelte';
  import EditView from './EditView.svelte';
  import PushQueue, { type PushRow } from './PushQueue.svelte';
  import ReviewQueue from './ReviewQueue.svelte';
  import JobProgress from './ui/JobProgress.svelte';

  // A chat's review as its own place, over the whole window (design doc 0015): its suggestions to
  // review, the edits made from them to decide side by side, the decided pages to stage, and the staged
  // pages to push, each a step of its own (ADR-060). The question box stays at the bottom, so the chat
  // can be asked to reword a suggestion or rework the open edit; Exit goes back where it was opened.
  type Props = {
    chat: AiChat;
    subject: string;
    /** "Exit to chat" or "Back to Review", saying where Exit goes. */
    exitLabel: string;
    onExit: () => void;
    /** The step to open on. */
    start?: Step;
    onSelectPage: (pageId: string) => void;
    onPushed: () => void;
    onWriteNewPage?: (finding: BranchFinding) => void;
  };

  let { chat, subject, exitLabel, onExit, start = 'review', onSelectPage, onPushed, onWriteNewPage }: Props = $props();
  // Where the flow opens is read once; after that the person moves through it.
  let step = $state<Step>(untrack(() => start));
  let open = $state<{ runId: string; pageId: string } | null>(null);
  let queue = $state<ChatQueue | null>(null);
  let loading = $state(true);
  let focus = $state<Focus | null>(null);
  let busy = $state<string | null>(null);
  let generation = 0;

  async function load(): Promise<void> {
    const id = chat.session?.id;
    const mine = ++generation;
    if (!id) {
      queue = null;
      loading = false;
      return;
    }
    try {
      const q = await sessions.queue(id);
      if (mine === generation) queue = q;
    } catch (e) {
      if (mine === generation) toast(`The review was not read: ${messageOf(e)}`, 'error');
    } finally {
      if (mine === generation) loading = false;
    }
  }

  // The review follows the conversation: an answer can add, reword or remove suggestions.
  $effect(() => {
    void chat.session?.id;
    void chat.session?.updatedAt;
    void load();
  });
  // Edits still being written are read again every second, and the header follows them meanwhile.
  $effect(() => {
    const running = queue?.runs.filter((r) => r.status === 'running') ?? [];
    if (!running.length) return;
    running.forEach((r) => jobs.watchReview(r));
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A dialog over the review, such as the push confirmation, takes Escape first.
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-overlay')) onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const counts = $derived(reviewCounts(queue));
  const countOf = (s: Step): number => counts[s];
  const runs = $derived([...(queue?.runs ?? [])].reverse());
  const items = $derived(runs.flatMap((run) => run.items.map((item) => ({ run, item }))));
  const atStage = $derived(items.filter(({ item }) => stepOf(item) === 'stage' || stepOf(item) === 'push'));
  // A run still holding work is shown open; one whose pages are all pushed, staged or closed folds away.
  // The newest run stays open too, so what it could not edit, and why, is seen.
  const current = (run: BranchRun): boolean =>
    run === runs[0] || run.status === 'running' || run.items.some((i) => stepOf(i) === 'edit');
  const suggestionsIn = (run: BranchRun): number =>
    new Set(run.items.flatMap((i) => [...(i.fixes ?? []), ...(i.freshness?.verdicts ?? [])].map((f) => f.suggestionId)))
      .size;
  // A clock for how long each page has been on its step, ticking only while edits are written.
  let now = $state(Date.now());
  $effect(() => {
    if (!runs.some((r) => r.status === 'running')) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const since = (at?: string): string => {
    if (!at) return '';
    const sec = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
  };
  const openRun = $derived(open ? queue?.runs.find((r) => r.id === open!.runId) : undefined);
  const openItem = $derived(openRun?.items.find((i) => i.pageId === open!.pageId));
  const turns = $derived(chat.session?.turns ?? []);
  const proposal = $derived.by(() => {
    if (!open) return null;
    for (let i = turns.length - 1; i >= 0; i--) {
      const p = turns[i].proposedEdit;
      if (p && !turns[i].proposalClosed && p.runId === open.runId && p.pageId === open.pageId)
        return { turn: i, text: p.text };
    }
    return null;
  });
  const lastAnswer = $derived(turns.findLast((t) => t.role === 'assistant')?.text);
  const accepted = (item: BranchItem): number => (item.changes ?? []).filter((c) => c.decision === 'accepted').length;
  const pushRows = $derived<PushRow[]>(
    items
      .filter(({ item }) => stepOf(item) === 'push')
      .map(({ run, item }) => ({
        runId: run.id,
        pageId: item.pageId,
        title: item.title,
        accepted: accepted(item),
        status: item.status,
        message: item.message,
      })),
  );

  function replace(run: BranchRun): void {
    if (queue) queue = { ...queue, runs: queue.runs.map((r) => (r.id === run.id ? run : r)) };
  }

  async function act(label: string, fn: () => Promise<BranchRun>): Promise<boolean> {
    busy = label;
    try {
      replace(await fn());
      return true;
    } catch (e) {
      toast(messageOf(e), 'error');
      return false;
    } finally {
      busy = null;
    }
  }

  async function onQueue(label: string, fn: () => Promise<ChatQueue>): Promise<void> {
    busy = label;
    try {
      queue = await fn();
    } catch (e) {
      toast(messageOf(e), 'error');
    } finally {
      busy = null;
    }
  }

  async function recommend(ids: string[]): Promise<void> {
    const id = chat.session?.id;
    if (!id) return;
    busy = 'recommend';
    try {
      const run = await sessions.recommend(id, ids);
      await load();
      jobs.watchReview(run);
      step = 'edit';
    } catch (e) {
      toast(`No edits were made: ${messageOf(e)}`, 'error');
    } finally {
      busy = null;
    }
  }

  async function decideProposal(turn: number, accept: boolean): Promise<void> {
    const id = chat.session?.id;
    if (!id) return;
    busy = 'proposal';
    try {
      if (accept) {
        const { session, run } = await sessions.acceptEdit(id, turn);
        chat.session = session;
        replace(run);
      } else {
        chat.session = await sessions.dismissEdit(id, turn);
      }
    } catch (e) {
      toast(messageOf(e), 'error');
    } finally {
      busy = null;
    }
  }

  function edit(run: BranchRun, item: BranchItem): void {
    open = { runId: run.id, pageId: item.pageId };
    focus = null;
    step = 'edit';
  }

  const STATE: Partial<Record<BranchItem['status'], string>> = {
    pending: 'Waiting',
    checking: 'Reading the page',
    working: 'Writing the edit',
    proposed: 'To decide',
    accepted: 'Ready to stage',
    rejected: 'Every change rejected',
    skipped: 'Not edited',
    failed: 'Failed',
    checked: 'Checked',
    'check-failed': 'Check found a problem',
    'push-failed': 'Push refused',
    pushed: 'Pushed',
  };
</script>

{#snippet runGroup(r: BranchRun)}
  {@const done = r.items.filter((i) => ['skipped', 'rejected'].includes(i.status))}
  <section class="run-group">
    <div class="run-head">
      <strong
        >{suggestionsIn(r)} suggestion{suggestionsIn(r) === 1 ? '' : 's'} · {r.items.length} page{r.items.length === 1
          ? ''
          : 's'}</strong
      >
      <span class="branch-note"
        >{new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span
      >
      {#if r.status === 'running'}
        <JobProgress
          processed={r.processed}
          total={r.total}
          onStop={() => void act('stop', () => branches.cancel(r.id))}
        />
      {/if}
    </div>
    <ul class="change-list">
      {#each r.items.filter((i) => !done.includes(i)) as item (item.pageId)}
        {@const last = item.steps?.at(-1)}
        <li>
          <button
            type="button"
            class={['branch-item-button', open?.runId === r.id && open.pageId === item.pageId && 'active']}
            onclick={() => edit(r, item)}
          >
            <span>{item.title}</span>
            {#if ['pending', 'checking', 'working'].includes(item.status) && r.status === 'running'}
              <span class="branch-note run-step"
                >{item.status === 'pending' ? 'Waiting for a free request' : last?.text}{item.status !== 'pending'
                  ? ` · ${since(last?.at)}`
                  : ''}{item.writing ? ` · ${item.writing.chars.toLocaleString()} characters so far` : ''}</span
              >
            {:else}
              <span class="branch-note">
                {item.changes?.length ?? 0} change{item.changes?.length === 1 ? '' : 's'} · {item.fixes?.length ?? 0}
                suggestion{item.fixes?.length === 1 ? '' : 's'}
              </span>
            {/if}
            <span class="branch-status status-{item.status}">{item.staged ? 'Staged' : STATE[item.status]}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if done.length}
      <details class="run-not-edited" open={r === runs[0]}>
        <summary class="branch-note">Not edited ({done.length})</summary>
        <ul>
          {#each done as item (item.pageId)}<li>{item.title}: {item.message ?? 'every change was rejected'}</li>{/each}
        </ul>
      </details>
    {/if}
  </section>
{/snippet}

{#snippet stepView()}
  {#if loading}
    <div class="empty-state"><span class="spinner" aria-hidden="true"></span> Reading the review…</div>
  {:else if step === 'review'}
    <div class="review-flow-pane review-flow-cards">
      <ReviewQueue
        suggestions={queue?.suggestions ?? []}
        busy={!!busy}
        onRecommend={(ids) => void recommend(ids)}
        onDismiss={(ids, undo) => void onQueue('dismiss', () => sessions.dismiss(chat.session!.id, ids, undo))}
        onRevert={(sid, to) => void onQueue('revert', () => sessions.revert(chat.session!.id, sid, to))}
        onOpenPage={onSelectPage}
        onOpenEdit={(runId, pageIds) => {
          const run = queue?.runs.find((r) => r.id === runId);
          const item = run?.items.find((i) => pageIds.includes(i.pageId));
          if (run && item) edit(run, item);
        }}
        {onWriteNewPage}
      />
    </div>
  {:else if step === 'edit'}
    <div class="review-edit">
      <aside class="review-edit-list" aria-label="Edits">
        {#if runs.length === 0}
          <p class="branch-note">No edits yet. Tick suggestions under Review and choose Write edits.</p>
        {:else}
          {#each runs.filter(current) as r (r.id)}{@render runGroup(r)}{/each}
          {#if runs.some((r) => !current(r))}
            <details class="queue-closed">
              <summary class="queue-section">Earlier runs ({runs.filter((r) => !current(r)).length})</summary>
              {#each runs.filter((r) => !current(r)) as r (r.id)}{@render runGroup(r)}{/each}
            </details>
          {/if}
        {/if}
      </aside>
      <section class="review-edit-main">
        {#if openRun && openItem}
          <EditView
            run={openRun}
            item={openItem}
            {busy}
            onBack={() => {
              open = null;
              focus = null;
            }}
            onChange={(cid, d) => act('decide', () => branches.decideChange(openRun.id, openItem.pageId, cid, d))}
            onAll={(d) => act('decide', () => branches.decideAll(openRun.id, openItem.pageId, d))}
            onSaveText={(text) => act('save', () => branches.saveText(openRun.id, openItem.pageId, text))}
            onReset={() => act('reset', () => branches.reset(openRun.id, openItem.pageId))}
            onRedo={() => act('redo', () => branches.redo(openRun.id, openItem.pageId))}
            onStage={(s) => act('stage', () => branches.stage(openRun.id, openItem.pageId, s))}
            {proposal}
            onProposal={(turn, accept) => void decideProposal(turn, accept)}
            focused={focus?.runId === openRun.id && focus.pageId === openItem.pageId}
            onRefine={() => (focus = { runId: openRun.id, pageId: openItem.pageId, title: openItem.title })}
            {lastAnswer}
          />
        {:else}
          <div class="empty-state">
            <FileText size={24} />
            <strong>Choose an edit</strong>
            <p>Each page an edit was written for is listed on the left. Open one to decide its changes side by side.</p>
          </div>
        {/if}
      </section>
    </div>
  {:else if step === 'stage'}
    <div class="review-flow-pane">
      {#if atStage.length === 0}
        <div class="empty-state">
          <PackageCheck size={24} />
          <strong>Nothing to stage yet</strong>
          <p>Decide every change of an edit, with at least one accepted, and it waits here to be staged.</p>
        </div>
      {:else}
        <ul class="stage-list">
          {#each atStage as { run, item } (`${run.id}/${item.pageId}`)}
            <li>
              <button class="link-btn" onclick={() => edit(run, item)} title="Open the edit">{item.title}</button>
              <span class="branch-note">{accepted(item)} accepted change{accepted(item) === 1 ? '' : 's'}</span>
              <span class="branch-status status-{item.status}">{item.staged ? 'Staged' : STATE[item.status]}</span>
              <span class="queue-spacer"></span>
              {#if item.staged}
                <button
                  class="btn btn-secondary btn-sm"
                  disabled={!!busy}
                  onclick={() => act('stage', () => branches.stage(run.id, item.pageId, false))}
                >
                  <PackageMinus size={13} /> Unstage
                </button>
              {:else}
                <button
                  class="btn btn-primary btn-sm"
                  disabled={!!busy}
                  onclick={() => act('stage', () => branches.stage(run.id, item.pageId, true))}
                >
                  {#if busy === 'stage'}<span class="spinner" aria-hidden="true"></span>{:else}<PackageCheck
                      size={13}
                    />{/if} Stage
                </button>
              {/if}
            </li>
          {/each}
        </ul>
        {#if counts.push}
          <button class="btn btn-secondary" onclick={() => (step = 'push')}>
            <Upload size={14} /> Go to Push ({counts.push})
          </button>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="review-flow-push">
      <PushQueue
        table
        rows={pushRows}
        onChanged={() => void load()}
        onPushed={() => {
          void load();
          onPushed();
        }}
      >
        {#snippet head()}
          <h2 class="space-push-title">Push</h2>
          <p class="space-push-lead">
            The pages staged from this chat. Each is checked against its current Confluence version first; a page
            someone changed since is refused, not overwritten. Pages staged in every chat of the space are pushed
            together from the Review page.
          </p>
        {/snippet}
      </PushQueue>
    </div>
  {/if}
{/snippet}

<div class="review-flow" role="dialog" aria-modal="true" aria-label="Review of {subject}">
  <header class="review-flow-bar">
    <button class="btn btn-secondary review-exit" onclick={onExit} title="{exitLabel} (Esc)">
      <ArrowLeft size={15} />
      {exitLabel}
    </button>
    <div class="review-flow-title">
      <strong>Review</strong>
      <span class="muted">{subject}</span>
    </div>
    <ol class="review-stepper" aria-label="Steps">
      {#each STEPS as s, i (s.id)}
        <li>
          <button
            type="button"
            class={['review-stepper-step', step === s.id && 'active']}
            aria-current={step === s.id ? 'step' : undefined}
            onclick={() => (step = s.id)}
          >
            <span class="review-stepper-number">{i + 1}</span>
            <span>{s.label}</span>
            <span class="review-stepper-count">{countOf(s.id)}</span>
          </button>
        </li>
      {/each}
    </ol>
  </header>
  <div class="review-flow-body">
    <ChatThread
      {chat}
      {subject}
      blocked={false}
      active
      {onSelectPage}
      placeholder={focus ? undefined : 'Ask the chat to reword a suggestion, or to change the open edit…'}
      view={stepView}
      {focus}
      onLeaveFocus={() => (focus = null)}
      onOpenTab={(t) => (step = t === 'review' ? 'review' : 'edit')}
      currentText={(runId, pageId) =>
        queue?.runs.find((r) => r.id === runId)?.items.find((i) => i.pageId === pageId)?.proposed}
      onEditDecided={() => void load()}
    />
  </div>
</div>
