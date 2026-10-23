<script lang="ts">
  import type { StagedPage } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import type { SpacePage } from '../support/pages.js';
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
    /** The space's pages, to say where each staged page sits. */
    pages: SpacePage[];
  };

  let { spaceKey, active, onPushed, onOpenChat, onCount, pages }: Props = $props();
  const pathOf = $derived(new Map(pages.map((p) => [p.id, p.path])));
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
  <PushQueue
    table
    rows={staged.map((s) => ({ ...s, path: pathOf.get(s.pageId) }))}
    onChanged={load}
    {onPushed}
    onOpenChat={(sessionId) => {
      const page = staged.find((s) => s.sessionId === sessionId);
      if (page) onOpenChat(page);
    }}
  >
    {#snippet head()}
      <h2 class="space-push-title">Ready to push</h2>
      <p class="space-push-lead">
        Staged edits from every chat in {spaceKey}. Each page is checked against its current Confluence version first; a
        page someone changed since is refused, not overwritten.
      </p>
      {#if error}<div class="alert alert-error">{error}</div>{/if}
    {/snippet}
  </PushQueue>
</div>
