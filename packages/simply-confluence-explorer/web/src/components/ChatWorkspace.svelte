<script lang="ts">
  import { FileText, Maximize2, Minimize2, WandSparkles } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import type { BranchFinding, BranchItem, BranchRun, ChatQueue } from '../../../src/api/types.js';
  import { branches, sessions, type Focus } from '../support/api.js';
  import type { AiChat } from '../support/chat.svelte.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ChatThread, { type Starter } from './ChatThread.svelte';
  import EditView from './EditView.svelte';
  import PushQueue, { type PushRow } from './PushQueue.svelte';
  import ReviewQueue from './ReviewQueue.svelte';
  import JobProgress from './ui/JobProgress.svelte';

  // A chat beside its review queue (ADR-060). The conversation is on the left; the queue on the right
  // shows one of three steps: the suggestions the chat made, the edits made from them to decide, and
  // the pages staged to push. An edit opens in place of the conversation, with the question box kept
  // below it, so the chat can be asked to rework the edit while it is open. Deciding an edit side by
  // side needs the whole width, so opening one takes the chat and its queue to the full window, with
  // the queue as a narrow column beside the edit; Exit full screen or Escape closes the edit and
  // brings them back.
  type Stage = 'open' | 'in-progress' | 'staged';
  type Props = {
    chat: AiChat;
    subject: string;
    blocked: boolean;
    active: boolean;
    onSelectPage: (pageId: string) => void;
    placeholder?: string;
    empty?: Snippet;
    starters?: Starter[];
    /** Shown above the conversation, such as what the chat reads. */
    top?: Snippet;
    /** Shown at the top of the conversation, scrolled with it, such as notes on the chat's files. */
    notes?: Snippet;
    onPushed: () => void;
    onWriteNewPage?: (finding: BranchFinding) => void;
    onOpenCount?: (n: number) => void;
    /** Show the review queue before the chat has asked or suggested anything. */
    queueWhenEmpty?: boolean;
    /** The question box as one row. */
    compact?: boolean;
  };

  let {
    chat,
    subject,
    blocked,
    active,
    onSelectPage,
    placeholder,
    empty,
    starters,
    top,
    notes,
    onPushed,
    onWriteNewPage,
    onOpenCount,
    queueWhenEmpty = true,
    compact = false,
  }: Props = $props();
  let stage = $state<Stage>('open');
  let fullscreen = $state(false);
  // An edit is decided only full screen, so leaving it closes the edit; the queue still lists it.
  function leaveFullscreen(): void {
    fullscreen = false;
    open = null;
    focus = null;
  }
  $effect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent): void => {
      // A dialog over the review, such as the push confirmation, takes Escape first.
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-overlay')) leaveFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  let queue = $state<ChatQueue | null>(null);
  let open = $state<{ runId: string; pageId: string } | null>(null);
  let focus = $state<Focus | null>(null);
  let busy = $state<string | null>(null);
  let generation = 0;

  async function load(): Promise<void> {
    const id = chat.session?.id;
    const mine = ++generation;
    if (!id) {
      queue = null;
      return;
    }
    try {
      const q = await sessions.queue(id);
      if (mine === generation) queue = q;
    } catch (e) {
      if (mine === generation) toast(`The queue was not read: ${messageOf(e)}`, 'error');
    }
  }

  // Another chat starts on its suggestions, with no edit open; a new answer in the same chat keeps
  // the step the person is on.
  const sessionId = $derived(chat.session?.id);
  let shownId: string | undefined;
  $effect(() => {
    // Reading the page again after a push reopens the same chat, which keeps its tab.
    if (!sessionId || sessionId === shownId) return;
    shownId = sessionId;
    stage = 'open';
    fullscreen = false;
    open = null;
    focus = null;
  });
  // The queues follow the conversation: an answer can add, reword or remove suggestions.
  $effect(() => {
    void sessionId;
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

  const runs = $derived([...(queue?.runs ?? [])].reverse());
  const items = $derived(runs.flatMap((run) => run.items.map((item) => ({ run, item }))));
  // What needs the person: edits being written or waiting to be decided, not yet staged.
  const NEEDS = ['pending', 'checking', 'working', 'proposed', 'accepted', 'failed', 'check-failed', 'push-failed'];
  const changes = $derived(items.filter(({ item }) => NEEDS.includes(item.status) && !item.staged));
  // A run still holding work is shown open; one whose pages are all pushed, staged or closed folds away.
  // The newest run stays open too, so what it could not edit, and why, is seen.
  const current = (run: BranchRun): boolean =>
    run === runs[0] || run.status === 'running' || run.items.some((i) => NEEDS.includes(i.status) && !i.staged);
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
  const staged = $derived(items.filter(({ item }) => item.staged && item.status !== 'pushed'));
  const openRun = $derived(open ? queue?.runs.find((r) => r.id === open!.runId) : undefined);
  const openItem = $derived(openRun?.items.find((i) => i.pageId === open!.pageId));
  const openCount = $derived(queue?.suggestions.filter((s) => s.state === 'open').length ?? 0);
  $effect(() => onOpenCount?.(openCount));
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
  const pushRows = $derived<PushRow[]>(
    staged.map(({ run, item }) => ({
      runId: run.id,
      pageId: item.pageId,
      title: item.title,
      accepted: (item.changes ?? []).filter((c) => c.decision === 'accepted').length,
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
      stage = 'in-progress';
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

  function openEdit(run: BranchRun, item: BranchItem): void {
    open = { runId: run.id, pageId: item.pageId };
    stage = item.staged ? 'staged' : 'in-progress';
    fullscreen = true;
  }

  // Once a conversation has begun, what it found or agreed can become suggestions; a fresh review
  // belongs in a new chat, where the starters offer it.
  const batch = $derived(jobs.batch(chat.session?.id));
  const steps = $derived<Array<{ id: Stage; label: string; n: number }>>([
    { id: 'open', label: 'Suggestions', n: openCount },
    { id: 'in-progress', label: 'Edits to decide', n: changes.length },
    { id: 'staged', label: 'Staged', n: staged.length },
  ]);
  const showQueue = $derived(queueWhenEmpty || turns.length > 0 || !!queue?.suggestions.length || !!queue?.runs.length);
  const canAdd = $derived(!blocked && turns.length > 0 && !chat.sending && !batch);

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

{#snippet reviewTab()}
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
      if (run && item) openEdit(run, item);
    }}
    {onWriteNewPage}
  />
{/snippet}

{#snippet editView()}
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
  {/if}
{/snippet}

{#snippet changesTab()}
  {#if runs.length === 0}
    <div class="empty-state review-empty">
      <FileText size={24} />
      <strong>No edits yet</strong>
      <p>Tick suggestions under 1 · Suggestions and choose Write edits. Each page they name gets an edit here.</p>
    </div>
  {:else}
    {#each runs.filter(current) as r (r.id)}{@render runGroup(r)}{/each}
    {#if runs.some((r) => !current(r))}
      <details class="queue-closed">
        <summary class="queue-section">Earlier runs ({runs.filter((r) => !current(r)).length})</summary>
        {#each runs.filter((r) => !current(r)) as r (r.id)}{@render runGroup(r)}{/each}
      </details>
    {/if}
  {/if}
{/snippet}

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
            onclick={() => openEdit(r, item)}
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

{#snippet pushTab()}
  <PushQueue rows={pushRows} onChanged={() => void load()} {onPushed} />
{/snippet}

<div class={['chat-review-frame', fullscreen && 'fullscreen']}>
  {#if fullscreen}
    <div class="review-fullbar">
      <strong>Review</strong>
      <span class="muted review-fullbar-subject">{subject}</span>
      <span class="spacer"></span>
      <button class="btn btn-secondary btn-sm" onclick={leaveFullscreen} title="Back to the chat (Esc)">
        <Minimize2 size={13} /> Exit full screen
      </button>
    </div>
  {/if}
  <div class="chat-review">
    <div class="chat-review-main">
      {@render top?.()}
      <ChatThread
        {chat}
        {subject}
        {blocked}
        {active}
        {onSelectPage}
        {placeholder}
        {empty}
        {starters}
        view={openRun && openItem ? editView : undefined}
        lead={notes}
        {compact}
        {focus}
        onLeaveFocus={() => (focus = null)}
        onOpenTab={(t) => (stage = t === 'review' ? 'open' : 'in-progress')}
        currentText={(runId, pageId) =>
          queue?.runs.find((r) => r.id === runId)?.items.find((i) => i.pageId === pageId)?.proposed}
        onEditDecided={() => void load()}
      />
    </div>
    {#if showQueue}
      <aside class="review-panel" aria-label="Review queue">
        <div class="review-panel-head">
          <h4>Review queue</h4>
          <span class="spacer"></span>
          {#if !fullscreen}
            <button
              class="btn-icon btn-icon-sm"
              onclick={() => (fullscreen = true)}
              title="Open the review full screen, with room to decide edits side by side"
              aria-label="Open the review full screen"
            >
              <Maximize2 size={14} />
            </button>
          {/if}
          <button
            class="btn btn-secondary btn-sm"
            disabled={!canAdd}
            onclick={() => chat.suggest('changes', 'Turn this conversation into changes')}
            title={turns.length
              ? 'Add the changes this conversation found or agreed to the review queue'
              : 'Ask something first; then what the chat found or agreed can be added here'}
          >
            <WandSparkles size={13} /> Add from chat
          </button>
        </div>
        <div class="review-steps" role="tablist" aria-label="Review steps">
          {#each steps as st, i (st.id)}
            <button
              type="button"
              role="tab"
              aria-selected={stage === st.id}
              class={['review-step', stage === st.id && 'active']}
              disabled={!chat.session}
              onclick={() => (stage = st.id)}
            >
              <span class="review-step-label">{i + 1} · {st.label}</span>
              <span class="review-step-count">{st.n}</span>
            </button>
          {/each}
        </div>
        <div class="review-panel-body">
          {#if stage === 'open'}
            {@render reviewTab()}
          {:else if stage === 'in-progress'}
            {@render changesTab()}
          {:else}
            {@render pushTab()}
          {/if}
        </div>
      </aside>
    {/if}
  </div>
</div>
