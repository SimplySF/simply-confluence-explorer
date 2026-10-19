<script lang="ts">
  import { MessagesSquare, Pencil, Plus, Search, Trash2 } from '@lucide/svelte';
  import type { SessionScope } from '../../../src/api/types.js';
  import { sessions, type DraftSummary } from '../support/api.js';
  import { AiChat } from '../support/chat.svelte.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ChatContext from './ChatContext.svelte';
  import ChatThread from './ChatThread.svelte';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';

  // Conversations about a space, kept on this machine and listed beside the one open (ADR-049). A chat
  // reads the whole space, where each question finds its own pages, or pages the person chose.
  export type ChatSeed = { title: string; scope: SessionScope };
  type Props = {
    spaceKey: string;
    /** The space's pages, to choose by name; excluded pages are never among them. */
    pages: Array<{ id: string; title: string }>;
    /** Start a conversation about these pages, such as a tag's. */
    seed: ChatSeed | null;
    onSeeded: () => void;
    active: boolean;
    onSelectPage: (pageId: string) => void;
  };

  let { spaceKey, pages, seed, onSeeded, active, onSelectPage }: Props = $props();
  const chat = new AiChat();
  let list = $state<DraftSummary[]>([]);
  let search = $state('');
  let renaming = $state<string | null>(null);
  let deleting = $state<DraftSummary | null>(null);

  const scope = $derived<SessionScope>({ kind: 'space', spaceKey });

  function reload(): void {
    sessions.inSpace(spaceKey).then(
      (l) => (list = l),
      () => (list = []),
    );
  }

  // Another space starts with a fresh conversation and its own list.
  $effect(() => {
    void spaceKey;
    chat.begin(scope);
    reload();
  });

  // The list follows the conversation: a new one appears, and one that was asked about moves to the top.
  $effect(() => {
    void chat.session?.updatedAt;
    reload();
  });

  $effect(() => {
    const wanted = seed;
    if (!wanted) return;
    onSeeded();
    chat.begin(wanted.scope);
    void (async () => {
      try {
        const s = await chat.ensure();
        chat.session = await sessions.update(s.id, { title: wanted.title });
      } catch (e) {
        toast(`The conversation was not started: ${messageOf(e)}`, 'error');
      }
    })();
  });

  async function open(id: string): Promise<void> {
    try {
      chat.show(await sessions.get(id), scope);
    } catch (e) {
      toast(messageOf(e), 'error');
    }
  }

  async function update(patch: { title?: string; scope?: Partial<SessionScope> }): Promise<void> {
    try {
      const s = await chat.ensure();
      chat.session = await sessions.update(s.id, patch);
    } catch (e) {
      toast(messageOf(e), 'error');
    }
  }

  async function remove(s: DraftSummary): Promise<void> {
    deleting = null;
    try {
      await sessions.remove(s.id);
      if (chat.session?.id === s.id) chat.startNew();
      reload();
    } catch (e) {
      toast(messageOf(e), 'error');
    }
  }

  // A chat is named by its first question; before that, by the space it is in.
  const heading = $derived(
    chat.session && (chat.session.turns.length > 0 || chat.session.title !== spaceKey)
      ? chat.session.title
      : `New chat about ${spaceKey}`,
  );
  const shown = $derived(list.filter((s) => s.title.toLowerCase().includes(search.trim().toLowerCase())));
</script>

<div class="space-chat">
  <aside class="space-chat-list">
    <button type="button" class="btn btn-primary btn-sm" onclick={() => chat.startNew()}>
      <Plus size={13} /> New chat
    </button>
    <div class="search-field">
      <Search size={13} />
      <input class="form-input input-sm" placeholder="Find a chat" aria-label="Find a chat" bind:value={search} />
    </div>
    <ul>
      {#each shown as s (s.id)}
        <li class={{ selected: s.id === chat.session?.id }}>
          <button type="button" class="space-chat-item" onclick={() => open(s.id)} title={s.title}>
            <span class="space-chat-item-title">{s.title}</span>
            <span class="space-chat-item-meta"
              >{new Date(s.updatedAt).toLocaleDateString()} · {Math.ceil(s.turnCount / 2)} question{Math.ceil(
                s.turnCount / 2,
              ) === 1
                ? ''
                : 's'}</span
            >
          </button>
          <button type="button" class="icon-btn" aria-label="Delete {s.title}" onclick={() => (deleting = s)}>
            <Trash2 size={12} />
          </button>
        </li>
      {/each}
    </ul>
  </aside>

  <section class="space-chat-main">
    <div class="space-chat-head">
      {#if renaming !== null}
        <form
          class="row"
          onsubmit={(e) => {
            e.preventDefault();
            const title = renaming?.trim();
            renaming = null;
            if (title) void update({ title });
          }}
        >
          <input class="form-input input-sm" aria-label="Name" maxlength="80" bind:value={renaming} />
          <button class="btn btn-secondary btn-sm">Save</button>
        </form>
      {:else}
        <h3><MessagesSquare size={16} /> {heading}</h3>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          title="Rename this chat"
          onclick={() => (renaming = chat.session?.title ?? '')}
        >
          <Pencil size={12} />
        </button>
      {/if}
    </div>
    <ChatContext
      {spaceKey}
      scope={chat.session?.scope ?? scope}
      {pages}
      onChange={(choice) => update({ scope: choice })}
      {onSelectPage}
    />
    <ChatThread
      {chat}
      subject="space {spaceKey}"
      blocked={false}
      {active}
      {onSelectPage}
      placeholder="Ask anything about {spaceKey}…"
    >
      {#snippet empty()}
        <MessagesSquare size={32} />
        <strong>Ask about {spaceKey}</strong>
        <p>
          The chat reads the whole space, finding the pages each question needs, or only the pages you choose under
          Reading above. Every answer names the pages it read. Chats are saved on this machine.
        </p>
      {/snippet}
    </ChatThread>
  </section>
</div>

{#if deleting}
  <ConfirmDialog
    title="Delete “{deleting.title}”?"
    onConfirm={() => deleting && remove(deleting)}
    onCancel={() => (deleting = null)}
  >
    {#snippet confirmLabel()}<Trash2 size={14} /> Delete{/snippet}
    <p>The conversation and any files added to it are removed from this machine.</p>
  </ConfirmDialog>
{/if}
