<script lang="ts">
  import { Paperclip } from '@lucide/svelte';
  import type { AttachmentChoice, AttachmentsReport } from '../../../src/api/types.js';
  import { attachmentLines, everyKey, filesByPage } from '../support/attachments.js';
  import type { AiChat } from '../support/chat.svelte.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ImagesNote from './ImagesNote.svelte';

  // The attachments of the pages a chat reads (ADR-069). Before the first question it lists every file
  // with a box to leave it out, and asks whether to include them, and again whenever files are added
  // after the chat chose, so no file is left behind unasked; under an answer it says what that answer
  // read and what it did not, each file with why.
  type Props = { spaceKey: string; report: AttachmentsReport; chat?: AiChat; before?: boolean };

  let { spaceKey, report, chat, before = false }: Props = $props();
  const lines = $derived(attachmentLines(report, before));
  const choice = $derived(chat?.session?.attachments ?? report.choice);
  const leftOut = $derived(chat?.session?.leftOutFiles ?? []);
  const pages = $derived(filesByPage(report));
  const fresh = $derived(pages.flatMap((p) => p.files.filter((f) => f.new && f.state !== 'fixed')));
  let saving = $state(false);
  // Open while there is something to choose, and kept open while files are ticked, until the person
  // closes it.
  let listOpen = $state(false);
  $effect(() => {
    if (!choice || fresh.length) listOpen = true;
  });

  async function save(next: AttachmentChoice, left: string[]): Promise<void> {
    if (!chat) return;
    saving = true;
    try {
      await chat.chooseAttachments({ choice: next, leftOut: left, seen: everyKey(report) });
    } catch (e) {
      toast(messageOf(e), 'error');
    } finally {
      saving = false;
    }
  }

  const toggle = (key: string, on: boolean): Promise<void> =>
    save('include', on ? leftOut.filter((k) => k !== key) : [...new Set([...leftOut, key])]);
</script>

{#if report.files > 0}
  <div class={['attachments-note', before && chat && (!choice || fresh.length) ? 'alert alert-warning' : 'muted']}>
    <p class="attachments-line">
      <Paperclip size={12} />
      <span>{before ? 'These pages have ' : 'The pages this answer read have '}{lines.line}</span>
      {#if before && chat && choice}
        <span>· {choice === 'pages' ? 'this chat reads pages only' : 'read with their pages'}</span>
        <button
          class="link-btn"
          disabled={saving}
          onclick={() => save(choice === 'pages' ? 'include' : 'pages', leftOut)}
        >
          {choice === 'pages' ? 'Include them' : 'Pages only'}
        </button>
      {/if}
    </p>
    {#if before && chat && !choice}
      <p class="attachments-ask">
        Include their {report.files} attachment{report.files === 1 ? '' : 's'} in this chat? Until you choose, they are read
        with their pages. Untick any you want to leave out below.
        <button class="btn btn-primary btn-xs" disabled={saving} onclick={() => save('include', [])}>Include all</button
        >
        <button class="btn btn-secondary btn-xs" disabled={saving} onclick={() => save('pages', leftOut)}
          >Pages only</button
        >
      </p>
    {:else if before && chat && choice !== 'pages' && fresh.length}
      <p class="attachments-ask">
        {fresh.length} attachment{fresh.length === 1 ? ' was' : 's were'} added to this chat's pages since you chose:
        {fresh.map((f) => f.name).join(', ')}. Until you choose, {fresh.length === 1 ? 'it is' : 'they are'} read.
        <button class="btn btn-primary btn-xs" disabled={saving} onclick={() => save('include', leftOut)}
          >Include them</button
        >
        <button
          class="btn btn-secondary btn-xs"
          disabled={saving}
          onclick={() => save('include', [...new Set([...leftOut, ...fresh.map((f) => f.key)])])}>Leave them out</button
        >
      </p>
    {/if}
    {#if before && chat && choice !== 'pages'}
      <details class="attachments-list" bind:open={listOpen}>
        <summary>Each file, ticked to go with this chat</summary>
        {#each pages as p (p.page)}
          <p class="branch-note">{p.page}</p>
          <ul class="attachments-files">
            {#each p.files as f (f.key)}
              <li>
                {#if f.state === 'fixed'}
                  <span class="muted">{f.name}: {f.detail}</span>
                {:else}
                  <label>
                    <input
                      type="checkbox"
                      checked={f.state === 'on'}
                      disabled={saving}
                      onchange={(e) => toggle(f.key, e.currentTarget.checked)}
                    />
                    {f.name} <span class="muted">· {f.detail}</span>{#if f.new}<strong> · new</strong>{/if}
                  </label>
                {/if}
              </li>
            {/each}
          </ul>
        {/each}
      </details>
    {:else if lines.read.length || lines.unread.length}
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
