<script lang="ts">
  import { Upload } from '@lucide/svelte';
  import type { StagedPage } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { messageOf } from '../support/toast.svelte.js';
  import PushQueue from './PushQueue.svelte';

  // Every page staged in a space's chats, pushed together (ADR-060). Each names the chat it came
  // from; an excluded page is never listed.
  type Props = {
    spaceKey: string;
    active: boolean;
    onPushed: () => void;
    onOpenChat: (page: StagedPage) => void;
    /** The number of staged pages changed, so the sidebar's count follows it. */
    onCount: (count: number) => void;
  };

  let { spaceKey, active, onPushed, onOpenChat, onCount }: Props = $props();
  let staged = $state<StagedPage[]>([]);
  let error = $state<string | null>(null);

  function load(): void {
    api.staged(spaceKey).then(
      (s) => {
        staged = s;
        error = null;
        onCount(s.length);
      },
      (e: unknown) => (error = messageOf(e)),
    );
  }
  $effect(() => {
    void spaceKey;
    if (active) load();
  });
</script>

<div class="space-push">
  <h3><Upload size={16} /> Ready to push · {spaceKey}</h3>
  <p class="branch-note">
    The pages staged in this space's chats. Each is written against the version its edit was made from.
  </p>
  {#if error}<div class="alert alert-error">{error}</div>{/if}
  <PushQueue
    rows={staged}
    onChanged={load}
    {onPushed}
    onOpenChat={(sessionId) => {
      const page = staged.find((s) => s.sessionId === sessionId);
      if (page) onOpenChat(page);
    }}
  />
</div>
