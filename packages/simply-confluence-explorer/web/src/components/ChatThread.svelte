<script lang="ts">
  import { Check, Clock, Code2, Copy, Paperclip, Send, ShieldCheck, Sparkles, Square, X } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import type { AiChat } from '../support/chat.svelte.js';
  import { toast } from '../support/toast.svelte.js';
  import Markdown from './ui/Markdown.svelte';

  // A conversation with the AI: its turns, the files added to it, and the box to ask the next question,
  // with Stop while an answer is coming (ADR-047). Ask AI and Space chat both show one.
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
  };

  let { chat, subject, blocked, active, onSelectPage, placeholder, empty }: Props = $props();
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
</script>

<div class="chat-stream">
  {#if turns.length === 0 && !chat.pending}
    <div class="empty-state">{@render empty?.()}</div>
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
        {#if t.matchedPages?.length}
          <details class="chat-read">
            <summary>
              Read {t.matchedPages.length} page{t.matchedPages.length === 1 ? '' : 's'}{t.considered
                ? ` · looked at ${t.considered}`
                : ''}
            </summary>
            <ul>
              {#each t.matchedPages as p (p.id)}
                <li>
                  <button class="link-btn" onclick={() => onSelectPage(p.id)} title="Open this page">{p.title}</button>
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
  {#if chat.error}<div class="alert alert-error">Not answered: {chat.error}</div>{/if}
  <div bind:this={bottom}></div>
</div>

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
