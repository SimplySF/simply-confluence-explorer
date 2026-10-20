<script lang="ts" module>
  import type { Component } from 'svelte';

  /**
   * A way to begin a chat without writing a question: a question to ask, or a review, whose answer is
   * a list of suggestions to tick and queue as edits (ADR-049).
   */
  export type Starter = { label: string; detail: string; icon: Component; prompt?: string; review?: boolean };
</script>

<script lang="ts">
  import {
    Activity,
    Check,
    Clock,
    Code2,
    Copy,
    ListChecks,
    Paperclip,
    Send,
    ShieldCheck,
    Sparkles,
    Square,
    Wand2,
    X,
  } from '@lucide/svelte';
  import { tick, type Snippet } from 'svelte';
  import type { BranchFinding } from '../../../src/api/types.js';
  import { sessions } from '../support/api.js';
  import type { AiChat } from '../support/chat.svelte.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { observe } from '../support/observe.svelte.js';
  import { readLabel, sentLines } from '../support/sources.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ChangeQueue from './ChangeQueue.svelte';
  import FindingsList from './FindingsList.svelte';
  import Markdown from './ui/Markdown.svelte';

  // A conversation with the AI: its turns, the files added to it, and the box to ask the next question,
  // with Stop while an answer is coming (ADR-047). An answer can hold suggestions, which the person
  // ticks and queues as edits, reviewed and pushed below it (ADR-049). The page's Chat tab and Space
  // chat both show one.
  type Props = {
    chat: AiChat;
    /** What the conversation is about, as the thinking note and the question box name it. */
    subject: string;
    /** Questions cannot be asked, such as for a page excluded from AI. */
    blocked: boolean;
    /** The conversation is on screen, so it scrolls to its newest answer. */
    active: boolean;
    onSelectPage: (pageId: string) => void;
    placeholder?: string;
    /** Shown before the first question. */
    empty?: Snippet;
    /** Ways to begin, shown until the first question is asked. */
    starters?: Starter[];
    /** Pages were written from a queue, so the tree and the page reload. */
    onPushed: () => void;
    /** A suggestion for a page that does not exist yet: start writing it. */
    onWriteNewPage?: (finding: BranchFinding) => void;
  };

  let {
    chat,
    subject,
    blocked,
    active,
    onSelectPage,
    placeholder,
    empty,
    starters = [],
    onPushed,
    onWriteNewPage,
  }: Props = $props();
  // The suggestions ticked on each answer, by the answer's place in the conversation.
  let chosen = $state<Record<number, Set<number>>>({});
  let queueing = $state<number | null>(null);

  async function queue(turn: number): Promise<void> {
    queueing = turn;
    try {
      await chat.queue(turn, [...(chosen[turn] ?? [])]);
      chosen[turn] = new Set();
      await tick();
      bottom.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } catch (e) {
      toast(`Nothing was queued: ${messageOf(e)}`, 'error');
    } finally {
      queueing = null;
    }
  }
  const UPLOAD_TYPES = '.pdf,.md,.markdown,.txt,.csv,.tsv,.json,.yaml,.yml,.log,.xml,.html,.htm';

  let input = $state('');
  let raw = $state<Record<number, boolean>>({});
  let copied = $state<number | null>(null);
  let seconds = $state(0);
  let bottom: HTMLDivElement;
  let files: HTMLInputElement;

  $effect(() => {
    if (!chat.sending) {
      seconds = 0;
      return;
    }
    const t = setInterval(() => (seconds += 0.1), 100);
    return () => clearInterval(t);
  });

  $effect(() => {
    void chat.session?.turns.length;
    void chat.sending;
    if (active) bottom.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  function ask(prompt: string): void {
    const clean = prompt.trim();
    if (!clean || chat.sending || blocked) return;
    input = '';
    void chat.send(clean);
  }

  function copy(i: number, text: string): void {
    navigator.clipboard.writeText(text).then(
      () => {
        copied = i;
        setTimeout(() => (copied = null), 1500);
      },
      () => toast('The browser blocked the clipboard; switch to Markdown and copy from there.', 'error'),
    );
  }

  const turns = $derived(chat.session?.turns ?? []);
  const attached = $derived(chat.session?.files ?? []);

  // A batched review of this chat's pages (ADR-051): picked up again after a reload, shown while it
  // runs, and its answer read when it finishes.
  const batch = $derived(jobs.batch(chat.session?.id));
  $effect(() => {
    const id = chat.session?.id;
    if (!id) return;
    const scope = chat.session?.scope;
    sessions.batch(id).then(
      ({ batch: running }) => running && jobs.watchBatch(running, scope?.kind === 'branch' ? scope.pageId : undefined),
      () => undefined, // Nothing running is the usual answer, and a failed check leaves nothing to show.
    );
  });
  $effect(() => jobs.onFinished((j) => j.kind === 'batch' && j.sessionId === chat.session?.id && void chat.reload()));
</script>

<div class="chat-stream">
  {#if turns.length === 0 && !chat.pending && !batch}
    <div class="empty-state">{@render empty?.()}</div>
    {#if starters.length && !blocked}
      <div class="chat-starters">
        {#each starters as s (s.label)}
          <button
            type="button"
            class="chat-starter"
            disabled={chat.sending}
            onclick={() => (s.review ? void chat.suggest('review', s.label) : s.prompt && ask(s.prompt))}
          >
            <span class="chat-starter-label"><s.icon size={14} /> {s.label}</span>
            <span class="chat-starter-detail">{s.detail}</span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
  {#each turns as t, i (i)}
    {#if t.role === 'user'}
      <div class="chat-msg chat-user">{t.text}</div>
    {:else}
      <div class="chat-msg chat-ai">
        <div class="chat-msg-head">
          <span>
            <Sparkles size={13} />
            {t.engine || 'AI'} · {new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span class="chat-msg-tools">
            {#if t.traceId}
              <button
                class="btn btn-secondary btn-xs"
                title="How this answer was made: what was searched, what was sent, and how long each step took"
                onclick={() => observe.show('trace', { traceId: t.traceId })}
              >
                <Activity size={11} /> Trace
              </button>
            {/if}
            <button class="btn btn-secondary btn-xs" onclick={() => (raw[i] = !raw[i])}>
              <Code2 size={11} />
              {raw[i] ? 'Formatted' : 'Markdown'}
            </button>
            <button class="btn btn-secondary btn-xs" onclick={() => copy(i, t.text)}>
              {#if copied === i}<Check size={11} />{:else}<Copy size={11} />{/if}
              {copied === i ? 'Copied' : 'Copy'}
            </button>
          </span>
        </div>
        {#if t.guardSummary}
          <div class="guard-note" title="Checked by the outbound guard before anything was sent">
            <ShieldCheck size={12} />
            {t.guardSummary}
          </div>
        {/if}
        {#if t.sent}
          {@const lines = sentLines(t.sent)}
          <details class="chat-read">
            <summary
              >What was sent: {lines.summary}{lines.leftOut.length
                ? ` · ${lines.leftOut.length} left out`
                : ''}</summary
            >
            {#if lines.leftOut.length}
              <ul>
                {#each lines.leftOut as l (l)}<li>{l}</li>{/each}
              </ul>
            {:else}
              <p class="muted">Everything this answer was meant to read reached the model.</p>
            {/if}
          </details>
        {/if}
        {#if t.corpus?.mode === 'batched'}
          <p class="chat-read">{readLabel(t)}</p>
        {:else if t.matchedPages?.length}
          <details class="chat-read">
            <summary>{readLabel(t)}</summary>
            <ul>
              {#each t.matchedPages as p (p.id)}
                <li>
                  <button class="link-btn" onclick={() => onSelectPage(p.id)} title="Open this page">{p.title}</button>
                  {#if p.sections?.length}<span> › {p.sections.map((s) => s.heading).join(', ')}</span>{/if}
                  {#if p.why}<span class="muted">: {p.why}</span>{/if}
                </li>
              {/each}
            </ul>
          </details>
        {/if}
        {#if raw[i]}
          <pre class="code-viewer-box">{t.text}</pre>
        {:else}
          <Markdown source={t.text} extraClass="ai-response-rendered" />
        {/if}
        {#if t.findings?.length}
          <div class="branch-findings">
            <FindingsList
              findings={t.findings}
              pageIds={t.pageIds ?? {}}
              chosen={chosen[i] ?? new Set()}
              onChange={(c) => (chosen[i] = c)}
              onOpenPage={onSelectPage}
              {onWriteNewPage}
            />
            <div class="review-footer">
              <span class="branch-note">Each page the ticked suggestions name gets an edit carrying only those.</span>
              <button
                class="btn btn-primary btn-sm"
                disabled={!chosen[i]?.size || queueing !== null}
                onclick={() => queue(i)}
              >
                <ListChecks size={13} /> Queue selected ({chosen[i]?.size ?? 0})
              </button>
            </div>
          </div>
        {/if}
        {#each t.runIds ?? [] as runId (runId)}
          <ChangeQueue {runId} {onPushed} />
        {/each}
      </div>
    {/if}
  {/each}
  {#if chat.pending}<div class="chat-msg chat-user">{chat.pending}</div>{/if}
  {#if chat.sending}
    <div class="ai-thinking-card">
      <div class="ai-thinking-header">
        <span><Sparkles size={15} class="spin" /> Thinking about {subject}…</span>
        <span class="muted"><Clock size={12} /> {seconds.toFixed(1)}s</span>
      </div>
      <div class="ai-thinking-shimmer"></div>
    </div>
  {/if}
  {#if batch}
    <div class="ai-thinking-card">
      <div class="ai-thinking-header">
        <span
          ><Sparkles size={15} class="spin" />
          {batch.label}: batch {Math.min(batch.processed + 1, batch.total)} of {batch.total}</span
        >
        <button class="btn btn-secondary btn-xs" onclick={() => jobs.stop(batch!)}><Square size={11} /> Stop</button>
      </div>
      <p class="muted">Related pages are read together. You can leave this chat; the header shows the progress.</p>
    </div>
  {/if}
  {#if chat.error}<div class="alert alert-error">Not answered: {chat.error}</div>{/if}
  <div bind:this={bottom}></div>
</div>

<!-- Once a conversation has begun, what it found or agreed can become suggestions; a fresh review
     belongs in a new chat, where the starters offer it. -->
{#if !blocked && turns.length > 0}
  <div class="chat-actions">
    <button
      class="btn btn-secondary btn-sm"
      disabled={chat.sending || !!batch}
      onclick={() => chat.suggest('changes', 'Turn this conversation into changes')}
      title="List the changes this conversation found or agreed, as suggestions to tick and queue as edits"
    >
      <Wand2 size={13} /> Turn this into changes
    </button>
    <span class="muted chat-actions-note">Lists what this chat found or agreed as edits you can tick and queue.</span>
  </div>
{/if}

{#if attached.length > 0}
  <div class="chat-files">
    {#each attached as f (f.id)}
      <span
        class="chat-file"
        title="{f.chars.toLocaleString()} characters{f.truncated ? ', cut to the per-file limit' : ''}"
      >
        <Paperclip size={11} />
        {f.name}
        <button type="button" onclick={() => chat.removeFile(f.id)} aria-label="Remove {f.name}"><X size={11} /></button
        >
      </span>
    {/each}
    <span class="chat-files-note">Checked by the leak guard; not covered by .confluenceignore.</span>
  </div>
{/if}

<form
  class="chat-input"
  onsubmit={(e) => {
    e.preventDefault();
    ask(input);
  }}
>
  <input
    bind:this={files}
    type="file"
    multiple
    hidden
    accept={UPLOAD_TYPES}
    onchange={(e) => {
      const picked = Array.from(e.currentTarget.files ?? []);
      e.currentTarget.value = '';
      if (picked.length) void chat.addFiles(picked);
    }}
  />
  <button
    type="button"
    class="btn btn-secondary"
    onclick={() => files.click()}
    disabled={chat.sending}
    title="Add files (PDF, Markdown, text, CSV, JSON, YAML, HTML) to this conversation"
    aria-label="Add files"
  >
    <Paperclip size={15} />
  </button>
  <input
    class="form-input"
    placeholder={placeholder ?? `Ask about ${subject}…`}
    bind:value={input}
    disabled={chat.sending || blocked}
  />
  {#if chat.sending}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => (input = chat.stop() ?? input)}
      title="Stop the answer and put the question back to edit"
    >
      <Square size={13} /> Stop
    </button>
  {:else}
    <button type="submit" class="btn btn-primary" disabled={!input.trim() || blocked}>
      <Send size={15} /> Send
    </button>
  {/if}
</form>
