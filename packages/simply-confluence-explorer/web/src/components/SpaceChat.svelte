<script lang="ts">
  import { Compass, FileText, MessagesSquare, Pencil, Plus, Search, Trash2 } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { BranchFinding, SessionScope } from '../../../src/api/types.js';
  import { jobs } from '../support/jobs.svelte.js';
  import type { SpacePage } from '../support/pages.js';
  import { sessions, type DraftSummary } from '../support/api.js';
  import { AiChat } from '../support/chat.svelte.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ChatContext from './ChatContext.svelte';
  import ChatThread, { type Starter } from './ChatThread.svelte';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';

  // Conversations about a space, kept on this machine and listed beside the one open (ADR-049). A chat
  // reads the whole space or the pages the person chose, and each question finds its sections (ADR-051).
  export type ChatSeed = { title: string; scope: SessionScope };
  type Props = {
    spaceKey: string;
    /** The space's pages, to choose by name; excluded pages are never among them. */
    pages: SpacePage[];
    /** Start a conversation about these pages, such as a tag's. */
    seed: ChatSeed | null;
    onSeeded: () => void;
    active: boolean;
    onSelectPage: (pageId: string) => void;
    /** Pages were written from a queue, so the tree and the page reload. */
    onPushed: () => void;
    onWriteNewPage: (finding: BranchFinding) => void;
  };

  let { spaceKey, pages, seed, onSeeded, active, onSelectPage, onPushed, onWriteNewPage }: Props = $props();
  const chat = new AiChat();
  let list = $state<DraftSummary[]>([]);
  let search = $state('');
  let renaming = $state<string | null>(null);
  let deleting = $state<DraftSummary | null>(null);
  // Counts the chats shown, so what a chat reads is reset when another chat is opened or started, but
  // not when the chat on screen is first saved.
  let shownChat = $state(0);
  // Read without tracking, so an effect that shows a new chat does not run again because of it.
  const nextChat = (): void => {
    shownChat = untrack(() => shownChat) + 1;
  };

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
    nextChat();
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
    nextChat();
    void (async () => {
      try {
        const s = await chat.ensure();
        chat.session = await sessions.update(s.id, { title: wanted.title });
      } catch (e) {
        toast(`The conversation was not started: ${messageOf(e)}`, 'error');
      }
    })();
  });

  // The header opened edits staged from one of this space's chats: show that chat.
  $effect(() => {
    const wanted = jobs.requested;
    if (!wanted?.sessionId || wanted.rootPageId || wanted.spaceKey !== spaceKey) return;
    jobs.requested = null;
    void open(wanted.sessionId);
  });

  async function open(id: string): Promise<void> {
    try {
      chat.show(await sessions.get(id), scope);
      nextChat();
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
  // Ways to begin a chat without a question of one's own. Chosen pages can be reviewed together; a
  // whole space is many requests to review, so it offers questions that find their way around it.
  const starters = $derived<Starter[]>(
    (chat.session?.scope ?? scope).kind === 'pages'
      ? [
          {
            label: 'Review for problems',
            detail:
              'Repeats, contradictions, out-of-date and missing pages across these pages, as suggestions you can tick and queue as edits.',
            icon: Search,
            review: true,
          },
          {
            label: 'Summarise these pages',
            detail: 'What they cover together, and how they relate.',
            icon: FileText,
            prompt: 'Summarise what these pages cover together, how they relate to each other, and where they overlap.',
          },
        ]
      : [
          {
            label: 'What does this space cover?',
            detail: 'Its main areas, and the pages where each is documented.',
            icon: Compass,
            prompt:
              'What does this space cover? Give an overview of its main areas and name the pages where each is documented.',
          },
          {
            label: 'Where should I start?',
            detail: 'The pages a newcomer should read first, in order.',
            icon: FileText,
            prompt: 'I am new to this space. Which pages should I read first, and in what order?',
          },
        ],
  );
  const shown = $derived(list.filter((s) => s.title.toLowerCase().includes(search.trim().toLowerCase())));
</script>

<div class="space-chat">
  <aside class="space-chat-list">
    <button
      type="button"
      class="btn btn-primary btn-sm"
      onclick={() => {
        chat.startNew();
        nextChat();
      }}
    >
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
            <span class="space-chat-item-title">{s.turnCount === 0 && s.title === spaceKey ? 'New chat' : s.title}</span
            >
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
    <!-- Each chat starts with its own choice of what to read. -->
    {#key shownChat}
      <ChatContext
        {spaceKey}
        scope={chat.session?.scope ?? scope}
        {pages}
        onChange={(choice) => update({ scope: choice })}
        {onSelectPage}
      />
    {/key}
    <ChatThread
      {chat}
      subject="space {spaceKey}"
      blocked={false}
      {active}
      {onSelectPage}
      placeholder="Ask anything about {spaceKey}…"
      {starters}
      {onPushed}
      {onWriteNewPage}
    >
      {#snippet empty()}
        <MessagesSquare size={32} />
        <strong>Ask about {spaceKey}</strong>
        <p>
          The chat reads the whole space, or the directories, pages and tags you choose under Reading above, however
          many there are. Each question finds the sections it needs, and every answer names them. Start with one of
          these, or ask your own question below. Chats are saved on this machine.
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
