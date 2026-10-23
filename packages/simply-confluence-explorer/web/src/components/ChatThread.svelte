<script lang="ts" module>
  import type { Component } from 'svelte';

  /**
   * A way to begin a chat without writing a question: a question to ask, or a review, whose answer is
   * a list of suggestions added to the chat's review queue (ADR-060).
   */
  export type Starter = { label: string; detail: string; icon: Component; prompt?: string; review?: boolean };
</script>

<script lang="ts">
  import {
    Activity,
    Bot,
    Check,
    Clock,
    Code2,
    Copy,
    FileText,
    Info,
    Layers,
    ListChecks,
    Paperclip,
    PenLine,
    Send,
    ShieldCheck,
    Sparkles,
    Square,
    X,
  } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import { sessions, type Focus } from '../support/api.js';
  import type { AiChat } from '../support/chat.svelte.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { observe } from '../support/observe.svelte.js';
  import { readLabel, sentLines } from '../support/sources.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import AttachmentsNote from './AttachmentsNote.svelte';
  import ImagesNote from './ImagesNote.svelte';
  import Diff from './ui/Diff.svelte';
  import Markdown from './ui/Markdown.svelte';

  // A conversation with the AI: its turns, the files added to it, and the box to ask the next question,
  // with Stop while an answer is coming (ADR-047). Suggestions an answer makes go to the chat's review
  // queue, which the answer links to; an answer about an open edit can propose a revision of it, to
  // accept or dismiss (ADR-060). The page's Chat & review tab and Space chat both show one.
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
    /** Shown in place of the conversation, such as an open edit; the question box stays. */
    view?: Snippet;
    /** Shown at the top of the conversation and scrolled with it, such as notes on what it reads. */
    lead?: Snippet;
    /** The edit the next question is about, while the person has it open. */
    focus?: Focus | null;
    onLeaveFocus?: () => void;
    /** Opens one of the chat's queues. */
    onOpenTab?: (tab: 'review' | 'changes') => void;
    /** The working text of an edit, so a revision the chat proposes is shown against it. */
    currentText?: (runId: string, pageId: string) => string | undefined;
    /** A revision was accepted or dismissed, so the queues are read again. */
    onEditDecided?: () => void;
    /** The question box as one row, for a chat with less room. */
    compact?: boolean;
    /** Shown just above the question box, such as what the chat's review holds. */
    aboveInput?: Snippet;
    /** Why a question must wait, such as the chat's pages still being checked; none when it need not. */
    waiting?: string;
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
    view,
    lead,
    focus = null,
    onLeaveFocus,
    onOpenTab,
    currentText,
    onEditDecided,
    compact = false,
    aboveInput,
    waiting,
  }: Props = $props();
  let deciding = $state<number | null>(null);

  /** Accepts or dismisses a revision the chat proposed for an open edit. */
  async function decideEdit(turn: number, accept: boolean): Promise<void> {
    const id = chat.session?.id;
    if (!id) return;
    deciding = turn;
    try {
      chat.session = accept ? (await sessions.acceptEdit(id, turn)).session : await sessions.dismissEdit(id, turn);
      onEditDecided?.();
    } catch (e) {
      toast(`The revision was not ${accept ? 'accepted' : 'dismissed'}: ${messageOf(e)}`, 'error');
    } finally {
      deciding = null;
    }
  }
  const queuedLine = (q: { added: number; updated: number; removed: number }): string =>
    [
      q.added ? `${q.added} added` : '',
      q.updated ? `${q.updated} reworded` : '',
      q.removed ? `${q.removed} removed` : '',
    ]
      .filter(Boolean)
      .join(', ');
  const UPLOAD_TYPES = '.pdf,.md,.markdown,.txt,.csv,.tsv,.json,.yaml,.yml,.log,.xml,.html,.htm';

  let input = $state('');
  let raw = $state<Record<number, boolean>>({});
  // An answer names its first pages as chips; the rest open on request, so a whole space's list does
  // not bury the answer.
  const SOURCES_SHOWN = 6;
  let allSources = $state<Record<number, boolean>>({});
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

  // While a question is answered, the step it is on, so a long wait shows what it is waiting for.
  let step = $state<string | null>(null);
  $effect(() => {
    const id = chat.session?.id;
    if (!chat.sending || !id) {
      step = null;
      return;
    }
    const ask = (): void => {
      sessions.activity(id).then(
        (a) => (step = a.step),
        () => undefined, // The step is a hint; the answer, or its error, arrives either way.
      );
    };
    const timer = setInterval(ask, 1000);
    ask();
    return () => clearInterval(timer);
  });

  $effect(() => {
    void chat.session?.turns.length;
    void chat.sending;
    if (active) bottom.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  function ask(prompt: string): void {
    const clean = prompt.trim();
    if (!clean || chat.sending || blocked || waiting) return;
    input = '';
    void chat.send(clean, thorough && canBeThorough && !focus, focus ?? undefined);
  }

  // A chat over many pages can read far more of them for one question, over several requests.
  let thorough = $state(false);
  const canBeThorough = $derived(chat.scopeKind !== undefined && chat.scopeKind !== 'page');
  const sectionsOf = (t: { matchedPages?: Array<{ sections?: unknown[] }> }): number =>
    (t.matchedPages ?? []).reduce((n, p) => n + (p.sections?.length ?? 0), 0);
  const plural = (n: number, word: string): string => `${n} ${n === 1 ? word : `${word}s`}`;

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

{#if view}
  <div class="chat-view">{@render view()}</div>
{/if}
<div class="chat-stream" hidden={!!view}>
  {@render lead?.()}
  {#if chat.opening}
    <div class="empty-state" role="status">
      <span class="spinner" aria-hidden="true"></span> Opening the conversation…
    </div>
  {:else if turns.length === 0 && !chat.pending && !batch}
    <div class="empty-state">{@render empty?.()}</div>
    {#if starters.length && !blocked}
      <div class="chat-starters">
        {#each starters as s (s.label)}
          <button
            type="button"
            class="chat-starter"
            disabled={chat.sending || !!waiting}
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
        <span class="chat-avatar" aria-hidden="true"><Bot size={15} /></span>
        <div class="chat-ai-body">
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
          {#if t.images && chat.session}<ImagesNote spaceKey={chat.session.scope.spaceKey} report={t.images} />{/if}
          {#if t.attachments && chat.session}<AttachmentsNote
              spaceKey={chat.session.scope.spaceKey}
              report={t.attachments}
            />{/if}
          {#if t.weakMatch}
            <div class="alert alert-warning chat-weak">
              Weak matches: the pages found share few words with the question, so this answer may not be about it. Try
              naming the system or page, or choose the pages to read under Reading.
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
          {#if t.corpus?.mode === 'retrieved' && !t.corpus.batches && i === turns.length - 1 && turns[i - 1]?.role === 'user' && !batch}
            <div class="chat-thorough-offer">
              <span class="muted">This answer read {plural(sectionsOf(t), 'section')} of many.</span>
              <button
                class="btn btn-secondary btn-xs"
                disabled={chat.sending}
                title="Read many more sections over several requests and combine what each found"
                onclick={() => void chat.send(turns[i - 1].text, true)}
              >
                <Layers size={11} /> Answer this thoroughly
              </button>
            </div>
          {/if}
          {#if t.corpus?.mode === 'batched'}
            <p class="chat-read">{readLabel(t)}</p>
          {/if}
          {#if raw[i]}
            <pre class="code-viewer-box">{t.text}</pre>
          {:else}
            <Markdown source={t.text} extraClass="ai-response-rendered" />
          {/if}
          {#if t.corpus?.mode !== 'batched' && t.matchedPages?.length}
            <div class="chat-sources">
              <span class="chat-sources-label">{readLabel(t)}</span>
              {#each allSources[i] ? t.matchedPages : t.matchedPages.slice(0, SOURCES_SHOWN) as p (p.id)}
                <button
                  class="chat-source"
                  onclick={() => onSelectPage(p.id)}
                  title={[
                    `Open ${p.title}`,
                    p.sections?.length ? `Sections: ${p.sections.map((s) => s.heading).join(', ')}` : '',
                    p.why ?? '',
                  ]
                    .filter(Boolean)
                    .join('\n')}
                >
                  <FileText size={12} />
                  {p.title}{#if p.sections?.length}<span class="chat-source-more"> › {p.sections.length}</span>{/if}
                </button>
              {/each}
              {#if t.matchedPages.length > SOURCES_SHOWN}
                <button class="link-btn chat-sources-toggle" onclick={() => (allSources[i] = !allSources[i])}>
                  {allSources[i] ? 'Show fewer' : `+ ${t.matchedPages.length - SOURCES_SHOWN} more`}
                </button>
              {/if}
            </div>
          {/if}
          {#if t.queued}
            <div class="chat-queued">
              <ListChecks size={13} /> Review queue: {queuedLine(t.queued)}.
              <button class="link-btn" onclick={() => onOpenTab?.('review')}>Review</button>
            </div>
          {/if}
          {#if t.proposedEdit}
            {@const p = t.proposedEdit}
            <div class="chat-proposal">
              <div class="chat-queued">
                <PenLine size={13} /> A revised edit of {p.title}
                {#if t.proposalClosed}<span class="muted">· decided</span>{/if}
                <button class="link-btn" onclick={() => onOpenTab?.('changes')}>Open the edit</button>
              </div>
              {#if !t.proposalClosed}
                <Diff before={currentText?.(p.runId, p.pageId) ?? ''} after={p.text} />
                <div class="branch-actions">
                  <button
                    class="btn btn-primary btn-sm"
                    disabled={deciding !== null}
                    onclick={() => decideEdit(i, true)}
                  >
                    <Check size={13} /> Accept into the edit
                  </button>
                  <button
                    class="btn btn-secondary btn-sm"
                    disabled={deciding !== null}
                    onclick={() => decideEdit(i, false)}
                  >
                    <X size={13} /> Dismiss
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  {/each}
  {#if chat.pending}<div class="chat-msg chat-user">{chat.pending}</div>{/if}
  {#if chat.sending}
    <div class="ai-thinking-card">
      <div class="ai-thinking-header">
        <span><Sparkles size={15} class="spin" /> {step ? `${step}…` : `Thinking about ${subject}…`}</span>
        <span class="muted"><Clock size={12} /> {seconds.toFixed(1)}s</span>
      </div>
      <div class="ai-thinking-shimmer"></div>
    </div>
  {/if}
  {#if batch}
    <div class="ai-thinking-card">
      <div class="ai-thinking-header">
        <span><Sparkles size={15} class="spin" /> {batch.label}: {batch.step}</span>
        <button class="btn btn-secondary btn-xs" onclick={() => jobs.stop(batch!)}><Square size={11} /> Stop</button>
      </div>
      <p class="muted">
        {batch.label.startsWith('Answering')
          ? "Each batch's notes are combined into one answer."
          : 'Related pages are read together.'} You can leave this chat; the header shows the progress.
      </p>
    </div>
  {/if}
  {#if chat.error}<div class="alert alert-error">Not answered: {chat.error}</div>{/if}
  <div bind:this={bottom}></div>
</div>

<!-- While an edit is open the conversation is out of sight, so its state is shown above the question box. -->
{#if view && (chat.sending || chat.error || turns.at(-1)?.role === 'assistant')}
  <div class="chat-peek">
    {#if chat.sending}
      <Sparkles size={13} class="spin" /> {step ? `${step}…` : 'Thinking…'}
    {:else if chat.error}
      <span class="branch-error">Not answered: {chat.error}</span>
    {:else}
      <Sparkles size={13} /> <span class="chat-peek-text">{turns.at(-1)?.text}</span>
    {/if}
  </div>
{/if}

{@render aboveInput?.()}

{#if waiting}
  <div class="chat-waiting" role="status">
    <span class="spinner" aria-hidden="true"></span>
    {waiting}
  </div>
{/if}

{#if focus}
  <div class="chat-focus">
    <PenLine size={13} /> Working on: <strong>{focus.title}</strong>
    <span class="muted">Your next message is about this edit.</span>
    <button class="link-btn" onclick={() => onLeaveFocus?.()}>Leave</button>
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
  class={['chat-composer', compact && 'compact']}
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
  <textarea
    class="chat-composer-input"
    rows={compact ? 1 : 2}
    placeholder={focus ? `Ask for a change to ${focus.title}…` : (placeholder ?? `Ask about ${subject}…`)}
    aria-label="Your question"
    bind:value={input}
    disabled={chat.sending || blocked}
    onkeydown={(e) => {
      // Enter asks; Shift+Enter starts a new line.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        ask(input);
      }
    }}
  ></textarea>
  <div class="chat-composer-row">
    <button
      type="button"
      class="btn-icon"
      onclick={() => files.click()}
      disabled={chat.sending}
      title="Add files (PDF, Markdown, text, CSV, JSON, YAML, HTML) to this conversation"
      aria-label="Add files"
    >
      <Paperclip size={16} />
    </button>
    {#if canBeThorough && !chat.sending && !view}
      <label class="chat-thorough">
        <input type="checkbox" bind:checked={thorough} disabled={blocked || !!batch} aria-describedby="thorough-hint" />
        Thorough
      </label>
      <button type="button" class="hint" aria-label="What Thorough does" aria-describedby="thorough-hint">
        <Info size={13} />
        <span class="hint-text" id="thorough-hint" role="tooltip">
          Reads up to 150 sections over several requests and combines what each found, instead of the dozen the question
          matches best. Slower; for broad questions across many pages.
        </span>
      </button>
    {/if}
    <span class="spacer"></span>
    {#if chat.sending}
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        onclick={() => (input = chat.stop() ?? input)}
        title="Stop the answer and put the question back to edit"
      >
        <Square size={13} /> Stop
      </button>
    {:else}
      <button
        type="submit"
        class="btn btn-primary btn-sm"
        disabled={!input.trim() || blocked || !!waiting || (thorough && !!batch)}
        title={waiting ? `Waiting: ${waiting}` : undefined}
      >
        <Send size={14} /> Send
      </button>
    {/if}
  </div>
</form>
