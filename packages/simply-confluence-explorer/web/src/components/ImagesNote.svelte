<script lang="ts">
  import { ImageIcon } from '@lucide/svelte';
  import type { ImageChoice, ImagesReport } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { imageChoices } from '../support/imageChoice.svelte.js';
  import { messageOf, toast } from '../support/toast.svelte.js';

  // What a request did with the images on the pages it read (ADR-066). While the space has not chosen,
  // it asks, so images are not forgotten; once it has, it says what was sent, or that none were.
  type Props = { spaceKey: string; report: ImagesReport };

  let { spaceKey, report }: Props = $props();
  const choice = $derived(imageChoices[spaceKey] ?? report.choice);
  const unseen = $derived(report.found - report.sent);
  const images = (n: number): string => `${n} image${n === 1 ? '' : 's'}`;

  async function choose(next: ImageChoice): Promise<void> {
    try {
      await api.saveSpaceSettings(spaceKey, next);
      imageChoices[spaceKey] = next;
      toast(
        next === 'send'
          ? `Images on ${spaceKey}'s pages are sent from the next request, without leak-guard checks.`
          : `Images on ${spaceKey}'s pages are not sent.`,
        'success',
      );
    } catch (e) {
      toast(messageOf(e), 'error');
    }
  }
</script>

{#if choice === 'ask' && unseen > 0}
  <div class="alert alert-warning images-note">
    <ImageIcon size={14} />
    <span>
      These pages have {images(unseen)} the AI did not see. Images are not checked by the leak guard, so they are only sent
      if you choose to for {spaceKey}.
    </span>
    <button class="btn btn-primary btn-xs" onclick={() => choose('send')}>Send images for {spaceKey}</button>
    <button class="btn btn-secondary btn-xs" onclick={() => choose('skip')}>Not for {spaceKey}</button>
  </div>
{:else if choice === 'skip' && unseen > 0}
  <p class="muted images-note">
    <ImageIcon size={12} />
    {images(unseen)} not sent (off for {spaceKey}).
    <button class="link-btn" onclick={() => choose('send')}>Send images for {spaceKey}</button>
  </p>
{:else if report.sent > 0}
  <p class="muted images-note">
    <ImageIcon size={12} />
    {images(report.sent)} sent without leak-guard checks{report.left?.length
      ? `; left out to fit the request: ${report.left.join(', ')}`
      : ''}.
  </p>
{/if}
