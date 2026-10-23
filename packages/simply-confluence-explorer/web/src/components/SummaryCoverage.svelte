<script lang="ts">
  import { untrack } from 'svelte';
  import { api, type Chosen, type Coverage } from '../support/api.js';
  import type { AiChat } from '../support/chat.svelte.js';
  import { jobs } from '../support/jobs.svelte.js';

  // How many of a chat's pages are in the AI index, which every part of the chat leans on: finding
  // sections, finding pages by tag, and answering, with an offer to index the rest; a phrase in the
  // chat's scope bar. The counts it reads are shared with the chat through `counts`, which also says
  // whether the pages fit one request, and lists their attachments, which the chat is asked about
  // (ADR-069).
  type Props = {
    spaceKey: string;
    /** A section's page, or the pages a chat chose; neither means the whole space. */
    rootPageId?: string;
    chosen?: Chosen;
    counts?: Coverage | null;
    /** The chat, whose choice about attachments changes what is counted. */
    chat?: AiChat;
    /** The count is being asked for, after the chat's pages or its choice changed. */
    checking?: boolean;
  };

  let { spaceKey, rootPageId, chosen, counts = $bindable(null), chat, checking = $bindable(false) }: Props = $props();
  let finished = $state(0);

  $effect(() => jobs.onFinished((j) => j.kind === 'summaries' && j.spaceKey === spaceKey && finished++));

  // While the space's search index is still being built, the count is asked for again until it is done.
  let again = $state(0);
  $effect(() => {
    void finished;
    void again;
    void chat?.session?.attachments;
    let live = true;
    const sessionId = chat?.session?.id;
    // A repeated ask while the index builds is not a new check: the build's progress is shown instead.
    if (!untrack(() => counts?.indexing)) checking = true;
    api
      .summaryCoverage(spaceKey, { rootPageId, ...chosen, ...(sessionId ? { sessionId } : {}) })
      .then(
        (c) => {
          if (!live) return;
          counts = c;
          if (c.indexing) setTimeout(() => live && again++, 2000);
        },
        () => live && (counts = null), // An unsynced space has no summaries to count; the line stays hidden.
      )
      .finally(() => live && (checking = false));
    return () => {
      live = false;
    };
  });

  const running = $derived(jobs.list.some((j) => j.kind === 'summaries' && j.spaceKey === spaceKey));
</script>

{#if checking}
  <span class="scope-coverage" role="status"><span class="spinner" aria-hidden="true"></span> Checking the pages…</span>
{:else if counts?.indexing}
  <span class="scope-coverage" role="status"
    ><span class="spinner" aria-hidden="true"></span> Building the search index, {counts.indexing.done} of {counts
      .indexing.total}</span
  >
{:else if counts && counts.pages > 0}
  <span class="scope-coverage">
    {counts.pages - counts.missing} of {counts.pages} indexed
    {#if counts.missing > 0}
      ·
      <button
        type="button"
        class="link-btn"
        disabled={running}
        onclick={() => jobs.startSummaries(spaceKey, rootPageId, chosen)}
        title="Chats find more in indexed pages: summaries, topics and the questions each page answers"
      >
        {running ? 'Indexing…' : counts.missing === counts.pages ? 'Index them' : 'Index the rest'}
      </button>
    {/if}
  </span>
{/if}
