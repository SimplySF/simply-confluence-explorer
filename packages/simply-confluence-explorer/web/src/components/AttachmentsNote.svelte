<script lang="ts">
  import { Paperclip } from '@lucide/svelte';
  import type { AttachmentsReport } from '../../../src/api/types.js';
  import { attachmentLines } from '../support/attachments.js';
  import type { AiChat } from '../support/chat.svelte.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ImagesNote from './ImagesNote.svelte';

  // The attachments of the pages a chat reads (ADR-069). Before the first question it lists them and,
  // when the chat has not chosen, asks whether to include them, so no file is left behind unasked;
  // under an answer it says what that answer read and what it did not, each file with why.
  type Props = { spaceKey: string; report: AttachmentsReport; chat?: AiChat; before?: boolean };

  let { spaceKey, report, chat, before = false }: Props = $props();
  const lines = $derived(attachmentLines(report, before));
  const choice = $derived(chat?.session?.attachments ?? report.choice);
  let saving = $state(false);

  async function choose(next: 'include' | 'pages'): Promise<void> {
    if (!chat) return;
    saving = true;
    try {
      await chat.chooseAttachments(next);
    } catch (e) {
      toast(messageOf(e), 'error');
    } finally {
      saving = false;
    }
  }
</script>

{#if report.files > 0}
  <div class={['attachments-note', before && !choice && chat ? 'alert alert-warning' : 'muted']}>
    <p class="attachments-line">
      <Paperclip size={12} />
      <span>{before ? 'These pages have ' : 'The pages this answer read have '}{lines.line}</span>
      {#if before && chat}
        {#if choice}
          <span>· {choice === 'pages' ? 'this chat reads pages only' : 'read with their pages'}</span>
          <button class="link-btn" disabled={saving} onclick={() => choose(choice === 'pages' ? 'include' : 'pages')}>
            {choice === 'pages' ? 'Include them' : 'Pages only'}
          </button>
        {/if}
      {/if}
    </p>
    {#if before && chat && !choice}
      <p class="attachments-ask">
        Include their {report.files} attachment{report.files === 1 ? '' : 's'} in this chat? Until you choose, they are read
        with their pages.
        <button class="btn btn-primary btn-xs" disabled={saving} onclick={() => choose('include')}>Include all</button>
        <button class="btn btn-secondary btn-xs" disabled={saving} onclick={() => choose('pages')}>Pages only</button>
      </p>
    {/if}
    {#if lines.read.length || lines.unread.length}
      <details class="attachments-list">
        <summary>{lines.unread.length ? `${lines.unread.length} not read, and why` : 'Each file'}</summary>
        {#if lines.unread.length}
          <p class="branch-note">Not read:</p>
          <ul>
            {#each lines.unread as l, n (n)}<li>{l}</li>{/each}
          </ul>
        {/if}
        {#if lines.read.length}
          <p class="branch-note">{before ? 'To be read' : 'Read'}:</p>
          <ul>
            {#each lines.read as l, n (n)}<li>{l}</li>{/each}
          </ul>
        {/if}
      </details>
    {/if}
  </div>
  {#if before && choice !== 'pages' && report.images.found}
    <ImagesNote {spaceKey} report={report.images} />
  {/if}
{/if}
