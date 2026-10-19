<script lang="ts">
  import { MessagesSquare, Pencil, Pin, Plus, Search, Trash2, X } from '@lucide/svelte';
  import type { SessionScope } from '../../../src/api/types.js';
  import { sessions, type DraftSummary } from '../support/api.js';
  import { AiChat } from '../support/chat.svelte.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ChatThread from './ChatThread.svelte';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';

  // Conversations about a whole space, kept on this machine and listed beside the one open (ADR-046).
  // Each answer is found from the pages that best match the question, the pages earlier answers used,
  // and any pages the person pinned.
  export type ChatSeed = { title: string; pinned: string[] };
  type Props = {
    spaceKey: string;
    /** The space's pages, for pinning; excluded pages are never among them. */
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
  let pinQuery = $state('');
  let deleting = $state<DraftSummary | null>(null);

  const scope = $derived<SessionScope>({ kind: 'space', spaceKey });
  const titleOf = (id: string): string => pages.find((p) => p.id === id)?.title ?? id;

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
    chat.startNew();
    void (async () => {
      try {
        const s = await chat.ensure();
        chat.session = await sessions.update(s.id, { title: wanted.title, pinned: wanted.pinned, pinnedOnly: true });
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

  async function update(patch: { title?: string; pinned?: string[]; pinnedOnly?: boolean }): Promise<void> {
    try {
      const s = await chat.ensure();
      chat.session = await sessions.update(s.id, patch);
    } catch (e) {
      toast(messageOf(e), 'error');
    }
  }

  function pin(): void {
    const page = pages.find((p) => p.title.toLowerCase() === pinQuery.trim().toLowerCase());
    if (!page) return;
    pinQuery = '';
    void update({ pinned: [...new Set([...(chat.session?.pinned ?? []), page.id])] });
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

  const shown = $derived(list.filter((s) => s.title.toLowerCase().includes(search.trim().toLowerCase())));
  const pinned = $derived(chat.session?.pinned ?? []);
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
        <h3><MessagesSquare size={16} /> {chat.session?.title ?? `New chat about ${spaceKey}`}</h3>
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
    <div class="space-chat-pins">
      <Pin size={12} />
      {#each pinned as id (id)}
        <span class="pill">
          <button type="button" class="link-btn" onclick={() => onSelectPage(id)}>{titleOf(id)}</button>
          <button
            type="button"
            class="icon-btn"
            aria-label="Unpin {titleOf(id)}"
            onclick={() => update({ pinned: pinned.filter((p) => p !== id) })}
          >
            <X size={11} />
          </button>
        </span>
      {/each}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          pin();
        }}
      >
        <input
          class="form-input input-sm"
          list="space-chat-pages"
          placeholder="Pin a page to every answer"
          aria-label="Pin a page"
          bind:value={pinQuery}
          onchange={pin}
        />
        <datalist id="space-chat-pages">
          {#each pages as p (p.id)}<option value={p.title}></option>{/each}
        </datalist>
      </form>
      {#if pinned.length > 0}
        <label class="review-check" title="Answer from the pinned pages alone, without searching the space">
          <input
            type="checkbox"
            checked={chat.session?.pinnedOnly === true}
            onchange={(e) => update({ pinnedOnly: e.currentTarget.checked })}
          />
          Only these pages
        </label>
      {/if}
    </div>
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
        <strong>Ask about the whole of {spaceKey}</strong>
        <p>
          Each answer is found from the pages that best match your question, and names them as its sources. Pin pages to
          include them every time. Chats are saved on this machine.
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
