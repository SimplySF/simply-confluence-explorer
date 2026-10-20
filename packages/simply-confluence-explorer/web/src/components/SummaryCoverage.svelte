<script lang="ts">
  import { Sparkles } from '@lucide/svelte';
  import { api, type Chosen, type Coverage } from '../support/api.js';
  import { jobs } from '../support/jobs.svelte.js';

  // One line in a chat when some of the pages it reads are not in the AI index, which every part of
  // the chat leans on: finding sections, finding pages by tag, and answering. It offers to index them.
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

  // While the space's search index is still being built, the count is asked for again until it is done.
  let again = $state(0);
  $effect(() => {
    void finished;
    void again;
    let live = true;
    api.summaryCoverage(spaceKey, { rootPageId, ...chosen }).then(
      (c) => {
        if (!live) return;
        counts = c;
        if (c.indexing) setTimeout(() => live && again++, 2000);
      },
      () => (counts = null), // An unsynced space has no summaries to count; the line stays hidden.
    );
    return () => {
      live = false;
    };
  });

  const running = $derived(jobs.list.some((j) => j.kind === 'summaries' && j.spaceKey === spaceKey));
</script>

{#if counts && counts.missing > 0}
  <div class="summary-coverage">
    <Sparkles size={12} />
    <span>
      Chats find more in indexed pages: {counts.pages - counts.missing} of {counts.pages}
      {counts.pages === 1 ? 'page here is' : 'pages here are'} indexed.
    </span>
    <button
      type="button"
      class="btn btn-secondary btn-xs"
      disabled={running}
      onclick={() => jobs.startSummaries(spaceKey, rootPageId, chosen)}
    >
      {running ? 'Indexing…' : 'Index the rest'}
    </button>
  </div>
{/if}
