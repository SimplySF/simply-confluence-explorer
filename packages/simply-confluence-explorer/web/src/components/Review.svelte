<script lang="ts">
  import { ArrowLeft, RefreshCw, Search, Wand2 } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { BranchFinding, BranchRun, ReviewAspect, ReviewSource } from '../../../src/api/types.js';
  import { api, branches, type BranchRunSummary } from '../support/api.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { messageOf } from '../support/toast.svelte.js';
  import FindingsList from './FindingsList.svelte';
  import StagedEdits from './StagedEdits.svelte';
  import JobProgress from './ui/JobProgress.svelte';

  // One review flow for a page, a section or a tag (ADR-046): choose the pages and what to look for,
  // read the suggestions, tick the ones to apply, then read, accept and push the staged edits.
  type Candidate = { id: string; title: string; depth?: number; path?: string };
  type Props = {
    spaceKey: string;
    source: ReviewSource;
    /** The pages to offer; loaded here for a page or a section when not given. */
    candidates?: Candidate[];
    /** A run to show straight away, such as one the header opened. */
    openRunId?: string;
    onOpenPage: (pageId: string) => void;
    /** Pages were written, so the tree and the page reload. */
    onPushed: () => void;
    onWriteNewPage?: (finding: BranchFinding) => void;
  };

  let { spaceKey, source, candidates, openRunId, onOpenPage, onPushed, onWriteNewPage }: Props = $props();

  const ASPECTS: Array<{ id: ReviewAspect; label: string }> = [
    { id: 'accuracy', label: 'Accuracy and contradictions' },
    { id: 'repetition', label: 'Repetition' },
    { id: 'staleness', label: 'Out of date' },
    { id: 'clarity', label: 'Clarity and tone' },
    { id: 'depth', label: 'Depth and prerequisites' },
    { id: 'structure', label: 'Structure' },
    { id: 'operations', label: 'Runbook and rollback' },
  ];

  let pages = $state<Candidate[]>([]);
  let ticked = $state(new Set<string>());
  let aspects = $state(new Set<ReviewAspect>(ASPECTS.map((a) => a.id)));
  let instructions = $state('');
  let run = $state<BranchRun | null>(null);
  let chosen = $state(new Set<number>());
  let history = $state<BranchRunSummary[]>([]);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);

  // The pages on offer, all ticked to start.
  $effect(() => {
    const given = candidates;
    const src = source;
    const set = (list: Candidate[]): void => {
      pages = list;
      ticked = new Set(list.map((p) => p.id));
    };
    if (given) set(given);
    else if (src.kind === 'section')
      api.section(spaceKey, src.rootPageId).then(set, (e: unknown) => (error = messageOf(e)));
    else if (src.kind === 'page') set([{ id: src.rootPageId, title: '' }]);
  });

  $effect(() => {
    void run?.id;
    branches.list(spaceKey, source).then(
      (h) => (history = h),
      () => (history = []),
    );
  });

  // A run still going for these pages, or the one asked for, opens straight away.
  $effect(() => {
    const wanted = openRunId ?? untrack(() => jobs.review(spaceKey, source)?.jobId);
    if (wanted && !untrack(() => run)) void act('open', () => branches.get(wanted));
  });

  // A running run is read again every second until it is ready, and the header follows it meanwhile.
  $effect(() => {
    const id = run?.id;
    if (!id || run?.status !== 'running') return;
    jobs.watchReview(run);
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
      const next = await fn();
      if (next.id !== run?.id) chosen = new Set();
      run = next;
      return true;
    } catch (e) {
      error = messageOf(e);
      return false;
    } finally {
      busy = null;
    }
  }

  const start = (): Promise<boolean> =>
    act('review', () =>
      branches.start({
        spaceKey,
        source,
        pageIds: pages.filter((p) => ticked.has(p.id)).map((p) => p.id),
        aspects: ASPECTS.filter((a) => aspects.has(a.id)).map((a) => a.id),
        instructions: instructions.trim() || undefined,
      }),
    );

  function toggle<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  const pageCount = $derived(Object.keys(run?.pageIds ?? {}).length);
</script>

{#if error}<div class="branch-error">{error}</div>{/if}

{#if !run}
  <div class="review-setup">
    {#if pages.length > 1}
      <section>
        <h4>Pages to read ({ticked.size} of {pages.length})</h4>
        <div class="review-pages">
          {#each pages as p (p.id)}
            <label class="review-check" style:padding-left="{(p.depth ?? 0) * 1}rem">
              <input type="checkbox" checked={ticked.has(p.id)} onchange={() => (ticked = toggle(ticked, p.id))} />
              <span>{p.title}</span>
              {#if p.path}<span class="branch-note">{p.path}</span>{/if}
            </label>
          {/each}
        </div>
      </section>
    {/if}
    <section>
      <h4>What to look for</h4>
      <div class="review-aspects">
        {#each ASPECTS as a (a.id)}
          <label class="review-check">
            <input type="checkbox" checked={aspects.has(a.id)} onchange={() => (aspects = toggle(aspects, a.id))} />
            {a.label}
          </label>
        {/each}
      </div>
      <textarea
        class="form-input"
        rows="3"
        aria-label="Anything to focus on"
        placeholder="Anything to focus on, or context the AI should know (optional), e.g. “we moved from Jenkins to GitLab CI in 2025”"
        bind:value={instructions}
      ></textarea>
      <div class="row">
        <button
          class="btn btn-primary btn-sm"
          disabled={!!busy || ticked.size === 0 || aspects.size === 0}
          onclick={start}
        >
          {#if busy === 'review'}<RefreshCw size={13} class="spin" /> Collecting pages…{:else}<Search size={13} /> Review
            {ticked.size} page{ticked.size === 1 ? '' : 's'}{/if}
        </button>
        <span class="branch-note">A review changes nothing; you choose which suggestions to apply.</span>
      </div>
    </section>
  </div>
  {#if history.length > 0}
    <div class="branch-history">
      <h4>Earlier runs</h4>
      {#each history as h (h.id)}
        <button class="branch-history-row" onclick={() => act('open', () => branches.get(h.id))}>
          {h.kind === 'review' ? 'Review' : h.fromRunId ? 'Staged edits' : `Improve (${h.focus})`} · {new Date(
            h.createdAt,
          ).toLocaleString()} · {h.pages} page{h.pages === 1 ? '' : 's'} · {h.status}
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
          ? `Reading ${pageCount} page${pageCount === 1 ? '' : 's'} with the AI`
          : run.items.find((i) => i.status === 'working')?.title}
        startedAt={run.createdAt}
        onStop={() => run && act('cancel', () => branches.cancel(run!.id))}
      />
    {:else}
      <span>
        {run.kind === 'review' ? `Review of ${pageCount} page${pageCount === 1 ? '' : 's'}` : 'Staged edits'} · {run.status}
      </span>
    {/if}
    {#if run.fromRunId}
      <button
        class="btn btn-secondary btn-sm"
        onclick={() => run?.fromRunId && act('open', () => branches.get(run!.fromRunId!))}
      >
        Back to the suggestions
      </button>
    {/if}
    <button class="btn btn-secondary btn-sm" onclick={() => (run = null)}><ArrowLeft size={13} /> New review</button>
  </div>
  {#if run.leftOut.length > 0}<div class="branch-note">Left out: {run.leftOut.join(', ')}.</div>{/if}
  {#if run.error}<div class="branch-error">{run.error}</div>{/if}

  {#if run.kind === 'review' && run.status === 'ready'}
    <div class="branch-findings">
      {#if run.findings}
        <FindingsList
          findings={run.findings}
          pageIds={run.pageIds ?? {}}
          {chosen}
          onChange={(c) => (chosen = c)}
          {onOpenPage}
          {onWriteNewPage}
        />
      {/if}
      {#if run.reportText}<pre class="branch-report">{run.reportText}</pre>{/if}
    </div>
    {#if run.findings?.length}
      <div class="review-footer">
        <span class="branch-note"
          >Each page the chosen suggestions name gets an edit carrying only those suggestions.</span
        >
        <button
          class="btn btn-primary"
          disabled={chosen.size === 0 || !!busy}
          onclick={() => run && act('apply', () => branches.apply(run!.id, [...chosen]))}
        >
          {#if busy === 'apply'}<RefreshCw size={14} class="spin" />{:else}<Wand2 size={14} />{/if} Apply selected ({chosen.size})
        </button>
      </div>
    {/if}
  {:else if run.kind === 'improve'}
    <StagedEdits
      {run}
      {busy}
      onDecide={(pageId, decision, edited) => act(decision, () => branches.decide(run!.id, pageId, decision, edited))}
      onCheck={() => run && act('check', () => branches.check(run!.id))}
      onPush={async () => {
        if (run && (await act('push', () => branches.push(run!.id)))) onPushed();
      }}
    />
  {/if}
{/if}
