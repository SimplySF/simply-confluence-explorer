<script lang="ts">
  import { ListChecks, WandSparkles } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import type { BranchFinding, ChatQueue } from '../../../src/api/types.js';
  import { sessions } from '../support/api.js';
  import type { AiChat } from '../support/chat.svelte.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { countsLine, reviewCounts, type Step } from '../support/review.js';
  import ChatThread, { type Starter } from './ChatThread.svelte';
  import ReviewFlow from './ReviewFlow.svelte';

  // A chat, with a bar above its question box that says what its review holds and opens it (design
  // doc 0015). The review is its own place over the whole window, so the conversation keeps the room;
  // Exit to chat comes back here.
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
    /** The question box as one row. */
    compact?: boolean;
    /** Why a question must wait, such as the chat's pages still being checked; none when it need not. */
    waiting?: string;
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
    compact = false,
    waiting,
  }: Props = $props();
  let queue = $state<ChatQueue | null>(null);
  let flow = $state<{ step: Step } | null>(null);
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
    } catch {
      // The bar is a summary; the review itself reports a queue it cannot read when opened.
      if (mine === generation) queue = null;
    }
  }

  const sessionId = $derived(chat.session?.id);
  $effect(() => {
    void sessionId;
    flow = null;
  });
  // The bar follows the conversation: an answer can add, reword or remove suggestions.
  $effect(() => {
    void sessionId;
    void chat.session?.updatedAt;
    void load();
  });

  const counts = $derived(reviewCounts(queue));
  $effect(() => onOpenCount?.(counts.review));
  const line = $derived(countsLine(counts));
  const turns = $derived(chat.session?.turns ?? []);
  // Once a conversation has begun, what it found or agreed can become suggestions; a fresh review
  // belongs in a new chat, where the starters offer it.
  const batch = $derived(jobs.batch(chat.session?.id));
  const canAdd = $derived(!blocked && turns.length > 0 && !chat.sending && !batch);
</script>

{#snippet reviewBar()}
  {#if line || turns.length > 0}
    <div class="review-bar">
      <ListChecks size={14} />
      <span class="review-bar-line">{line ? `Review: ${line}` : 'No suggestions yet'}</span>
      {#if line}
        <button class="btn btn-primary btn-xs" onclick={() => (flow = { step: 'review' })}>Open the review</button>
      {/if}
      <span class="spacer"></span>
      <button
        class="btn btn-secondary btn-xs"
        disabled={!canAdd}
        onclick={() => chat.suggest('changes', 'Turn this conversation into changes')}
        title="Add the changes this conversation found or agreed to the review"
      >
        {#if chat.pending === 'Turn this conversation into changes'}<span class="spinner" aria-hidden="true"
          ></span>{:else}<WandSparkles size={12} />{/if} Add from chat
      </button>
    </div>
  {/if}
{/snippet}

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
  lead={notes}
  aboveInput={reviewBar}
  {compact}
  {waiting}
  onOpenTab={(t) => (flow = { step: t === 'review' ? 'review' : 'edit' })}
/>

{#if flow}
  <ReviewFlow
    {chat}
    {subject}
    exitLabel="Exit to chat"
    start={flow.step}
    onExit={() => {
      flow = null;
      void load();
    }}
    onSelectPage={(id) => {
      flow = null;
      onSelectPage(id);
    }}
    {onPushed}
    {onWriteNewPage}
  />
{/if}
