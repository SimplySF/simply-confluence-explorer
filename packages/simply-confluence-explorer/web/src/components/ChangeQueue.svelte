<script lang="ts">
  import type { BranchRun } from '../../../src/api/types.js';
  import { branches } from '../support/api.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { messageOf } from '../support/toast.svelte.js';
  import StagedEdits from './StagedEdits.svelte';
  import JobProgress from './ui/JobProgress.svelte';

  // One queue of edits staged from a chat's suggestions: they arrive one page at a time, then each
  // change is accepted or rejected, and the accepted ones are checked and pushed (ADR-024, ADR-059).
  type Props = {
    runId: string;
    /** Pages were written, so the tree and the page reload. */
    onPushed: () => void;
  };

  let { runId, onPushed }: Props = $props();
  let run = $state<BranchRun | null>(null);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    branches.get(runId).then(
      (r) => (run = r),
      (e: unknown) => (error = messageOf(e)),
    );
  });

  // A queue still being written is read again every second, and the header follows it meanwhile.
  $effect(() => {
    if (run?.status !== 'running') return;
    jobs.watchReview(run);
    const timer = setInterval(() => {
      branches.get(runId).then(
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
</script>

<div class="change-queue">
  {#if error}<div class="branch-error">{error}</div>{/if}
  {#if run}
    <div class="branch-runbar">
      {#if run.status === 'running'}
        <JobProgress
          processed={run.processed}
          total={run.total}
          current={run.items.find((i) => i.status === 'working')?.title}
          onStop={() => act('cancel', () => branches.cancel(runId))}
        />
      {:else}
        <strong>Changes ({run.items.length})</strong>
        <span class="branch-note"
          >{run.status === 'cancelled' ? 'Stopped' : 'Accept or reject each change, then check and push'}</span
        >
      {/if}
    </div>
    {#if run.leftOut.length > 0}<div class="branch-note">Left out: {run.leftOut.join(', ')}.</div>{/if}
    <StagedEdits
      {run}
      {busy}
      onChange={(pageId, changeId, d) => act(d, () => branches.decideChange(runId, pageId, changeId, d))}
      onAll={(pageId, d) => act(d, () => branches.decideAll(runId, pageId, d))}
      onSaveText={(pageId, text) => act('save', () => branches.saveText(runId, pageId, text))}
      onReset={(pageId) => act('reset', () => branches.reset(runId, pageId))}
      onRedo={(pageId) => act('redo', () => branches.redo(runId, pageId))}
      onCheck={() => act('check', () => branches.check(runId))}
      onPush={async () => {
        if (await act('push', () => branches.push(runId))) onPushed();
      }}
    />
  {/if}
</div>
