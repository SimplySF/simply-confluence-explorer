<script lang="ts">
  import { Sparkles } from '@lucide/svelte';
  import { api } from '../support/api.js';
  import { jobs } from '../support/jobs.svelte.js';

  // One line in a chat when some of the pages it reads have no AI summary, which every part of the
  // chat leans on: choosing pages, finding them by tag, and answering. It offers to generate them.
  type Props = {
    spaceKey: string;
    /** A section's page, or the pages a chat reads; neither means the whole space. */
    rootPageId?: string;
    pageIds?: string[];
  };

  let { spaceKey, rootPageId, pageIds }: Props = $props();
  let counts = $state<{ pages: number; missing: number } | null>(null);
  let finished = $state(0);

  $effect(() => jobs.onFinished((j) => j.kind === 'summaries' && j.spaceKey === spaceKey && finished++));

  $effect(() => {
    void finished;
    const body = { rootPageId, pageIds: pageIds?.length ? pageIds : undefined };
    api.summaryCoverage(spaceKey, body).then(
      (c) => (counts = c),
      () => (counts = null), // An unsynced space has no summaries to count; the line stays hidden.
    );
  });

  const running = $derived(jobs.list.some((j) => j.kind === 'summaries' && j.spaceKey === spaceKey));
</script>

{#if counts && counts.missing > 0}
  <div class="summary-coverage">
    <Sparkles size={12} />
    <span>
      Answers are better with AI summaries: {counts.pages - counts.missing} of {counts.pages} page{counts.pages === 1
        ? ''
        : 's'} here have one.
    </span>
    <button
      type="button"
      class="btn btn-secondary btn-xs"
      disabled={running}
      onclick={() => jobs.startSummaries(spaceKey, rootPageId, pageIds?.length ? pageIds : undefined)}
    >
      {running ? 'Generating…' : 'Generate the missing summaries'}
    </button>
  </div>
{/if}
