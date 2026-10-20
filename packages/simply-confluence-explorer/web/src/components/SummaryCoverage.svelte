<script lang="ts">
  import { Sparkles } from '@lucide/svelte';
  import { api, type Chosen, type Coverage } from '../support/api.js';
  import { jobs } from '../support/jobs.svelte.js';

  // One line in a chat when some of the pages it reads have no AI summary, which every part of the
  // chat leans on: finding sections, finding pages by tag, and answering. It offers to generate them.
  // The counts it reads are shared with the chat through `counts`, which also says whether the pages
  // fit one request.
  type Props = {
    spaceKey: string;
    /** A section's page, or the pages a chat chose; neither means the whole space. */
    rootPageId?: string;
    chosen?: Chosen;
    counts?: Coverage | null;
  };

  let { spaceKey, rootPageId, chosen, counts = $bindable(null) }: Props = $props();
  let finished = $state(0);

  $effect(() => jobs.onFinished((j) => j.kind === 'summaries' && j.spaceKey === spaceKey && finished++));

  $effect(() => {
    void finished;
    api.summaryCoverage(spaceKey, { rootPageId, ...chosen }).then(
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
        : 's'} here have an up-to-date one.
    </span>
    <button
      type="button"
      class="btn btn-secondary btn-xs"
      disabled={running}
      onclick={() => jobs.startSummaries(spaceKey, rootPageId, chosen)}
    >
      {running ? 'Generating…' : 'Generate the missing summaries'}
    </button>
  </div>
{/if}
