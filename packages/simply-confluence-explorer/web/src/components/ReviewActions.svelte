<script lang="ts">
  import { Ellipsis, Eraser, Trash2 } from '@lucide/svelte';
  import type { ReviewCounts } from '../../../src/api/types.js';
  import { sessions } from '../support/api.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
  import Menu from './ui/Menu.svelte';

  // Clearing a chat's review, or deleting the chat with it, each asked first. Pages already pushed
  // stay as they are either way.
  type Props = {
    sessionId: string;
    title: string;
    counts: ReviewCounts;
    onDone: (what: 'cleared' | 'deleted') => void;
  };

  let { sessionId, title, counts, onDone }: Props = $props();
  let asking = $state<'clear' | 'delete' | null>(null);
  let busy = $state(false);

  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

  async function act(): Promise<void> {
    const what = asking;
    busy = true;
    try {
      if (what === 'clear') await sessions.clearReview(sessionId);
      else await sessions.remove(sessionId);
      asking = null;
      onDone(what === 'clear' ? 'cleared' : 'deleted');
    } catch (e) {
      toast(`The review was not ${what === 'clear' ? 'cleared' : 'deleted'}: ${messageOf(e)}`, 'error');
    } finally {
      busy = false;
    }
  }
</script>

<Menu
  title="More for this review"
  items={[
    { label: 'Clear the review', icon: Eraser, onSelect: () => (asking = 'clear'), hint: 'The conversation is kept' },
    { label: 'Delete the chat', icon: Trash2, onSelect: () => (asking = 'delete'), danger: true },
  ]}
>
  {#snippet label()}<Ellipsis size={14} />{/snippet}
</Menu>

{#if asking}
  <ConfirmDialog
    title={asking === 'clear' ? `Clear the review of “${title}”?` : `Delete “${title}”?`}
    danger={asking === 'delete'}
    {busy}
    onConfirm={() => void act()}
    onCancel={() => (asking = null)}
  >
    {#snippet confirmLabel()}
      {#if busy}<span class="spinner" aria-hidden="true"></span>{:else if asking === 'clear'}<Eraser
          size={14}
        />{:else}<Trash2 size={14} />{/if}
      {asking === 'clear' ? 'Clear' : 'Delete'}
    {/snippet}
    {#if asking === 'clear'}
      <p>
        Dismisses {plural(counts.review, 'suggestion')}, sets aside {plural(counts.edit + counts.stage, 'edit')} and unstages
        {plural(counts.push, 'page')}. Pages already pushed are not changed. The conversation is kept.
      </p>
    {:else}
      <p>Deletes the conversation and its review from this machine. Pages already pushed are not changed.</p>
    {/if}
  </ConfirmDialog>
{/if}
