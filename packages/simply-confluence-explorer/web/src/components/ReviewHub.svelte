<script lang="ts">
  import { FileText, Folder, Globe, ListChecks, Upload } from '@lucide/svelte';
  import type { ChatReview, StagedPage } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import type { SpacePage } from '../support/pages.js';
  import { countsLine } from '../support/review.js';
  import { messageOf } from '../support/toast.svelte.js';
  import PushQueue from './PushQueue.svelte';
  import ReviewActions from './ReviewActions.svelte';

  // The Review page (design doc 0015): every chat in the space whose review holds work, each opening
  // its review, and the pages staged in every chat, to push together. An excluded page is never listed
  // or counted.
  type Props = {
    spaceKey: string;
    active: boolean;
    pages: SpacePage[];
    onOpen: (chat: ChatReview) => void;
    onPushed: () => void;
    /** How many chats have work waiting, so the sidebar's count follows it. */
    onCount: (count: number) => void;
  };

  let { spaceKey, active, pages, onOpen, onPushed, onCount }: Props = $props();
  const pathOf = $derived(new Map(pages.map((p) => [p.id, p.path])));
  const titleOf = $derived(new Map(pages.map((p) => [p.id, p.title])));
  let chats = $state<ChatReview[] | null>(null);
  let staged = $state<StagedPage[]>([]);
  let error = $state<string | null>(null);

  const waiting = (c: ChatReview): number => c.counts.review + c.counts.edit + c.counts.stage + c.counts.push;
  const withWork = $derived((chats ?? []).filter((c) => waiting(c) > 0));
  const done = $derived((chats ?? []).filter((c) => waiting(c) === 0));

  function load(): void {
    Promise.all([api.reviews(spaceKey), api.staged(spaceKey)]).then(
      ([c, s]) => {
        chats = c;
        staged = s;
        error = null;
        onCount(c.filter((x) => waiting(x) > 0).length);
      },
      (e: unknown) => {
        chats ??= [];
        error = messageOf(e);
      },
    );
  }
  $effect(() => {
    void spaceKey;
    if (active) load();
  });

  const reads = (c: ChatReview): { icon: typeof Globe; text: string } => {
    if (c.scope.kind === 'space') return { icon: Globe, text: 'Space chat, the whole space' };
    if (c.scope.kind === 'pages') return { icon: Globe, text: 'Space chat, chosen pages' };
    const title = (c.scope.pageId && titleOf.get(c.scope.pageId)) || c.scope.title || 'a page';
    return c.scope.kind === 'branch'
      ? { icon: Folder, text: `${title} and its sub-pages` }
      : { icon: FileText, text: title };
  };
</script>

{#snippet card(c: ChatReview)}
  {@const r = reads(c)}
  <li class="hub-chat">
    <div class="hub-chat-text">
      <strong>{c.title}</strong>
      <span class="hub-chat-reads"><r.icon size={12} /> {r.text}</span>
      <span class="hub-chat-counts">{countsLine(c.counts) || 'Nothing left to do'}</span>
    </div>
    <span class="hub-chat-when">{new Date(c.updatedAt).toLocaleDateString()}</span>
    <button class="btn btn-primary btn-sm" onclick={() => onOpen(c)}>Open the review</button>
    <ReviewActions sessionId={c.sessionId} title={c.title} counts={c.counts} onDone={load} />
  </li>
{/snippet}

<div class="space-push">
  <PushQueue
    table
    quietWhenEmpty
    rows={staged.map((s) => ({ ...s, path: pathOf.get(s.pageId) }))}
    onChanged={load}
    onPushed={() => {
      load();
      onPushed();
    }}
    onOpenChat={(sessionId) => {
      const chat = chats?.find((c) => c.sessionId === sessionId);
      if (chat) onOpen(chat);
    }}
  >
    {#snippet head()}
      <h2 class="space-push-title">Review</h2>
      <p class="space-push-lead">
        The chats in {spaceKey} with suggestions or edits waiting. Open one to go through its review: review the suggestions,
        decide the edits, stage the pages and push them.
      </p>
      {#if error}<div class="alert alert-error">{error}</div>{/if}
      {#if chats === null}
        <p class="muted hub-loading"><span class="spinner" aria-hidden="true"></span> Reading the chats' reviews…</p>
      {:else if withWork.length === 0}
        <div class="empty-state hub-empty">
          <ListChecks size={24} />
          <strong>Nothing waits for review</strong>
          <p>
            Ask a chat to review its pages, or choose Add from chat in a conversation, and its review is listed here.
          </p>
        </div>
      {:else}
        <ul class="hub-chats">
          {#each withWork as c (c.sessionId)}{@render card(c)}{/each}
        </ul>
      {/if}
      {#if done.length}
        <details class="queue-closed hub-done">
          <summary>Done ({done.length})</summary>
          <ul class="hub-chats">
            {#each done as c (c.sessionId)}{@render card(c)}{/each}
          </ul>
        </details>
      {/if}
      {#if staged.length}
        <h3 class="hub-push-title"><Upload size={16} /> Push all staged</h3>
        <p class="space-push-lead">
          Pages staged in every chat of {spaceKey}. Each is checked against its current Confluence version first; a page
          someone changed since is refused, not overwritten.
        </p>
      {/if}
    {/snippet}
  </PushQueue>
</div>
