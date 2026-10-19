<script lang="ts" module>
  export type AiScope = 'page' | 'branch' | 'space';
</script>

<script lang="ts">
  import {
    Bot,
    Check,
    Clock,
    Code2,
    Copy,
    FileText,
    Lightbulb,
    ListOrdered,
    Paperclip,
    RotateCcw,
    Send,
    ShieldCheck,
    ShieldOff,
    Sparkles,
    Square,
    UserCheck,
    X,
  } from '@lucide/svelte';
  import type { PageDetail } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { AiChat } from '../support/chat.svelte.js';
  import { toast } from '../support/toast.svelte.js';
  import Markdown from './ui/Markdown.svelte';
  import Segmented from './ui/Segmented.svelte';

  // One conversation with the AI about a page, the page and everything under it, or the whole space.
  type Props = {
    detail: PageDetail;
    spaceKey: string;
    excluded: boolean;
    descendantCount: number;
    scope: AiScope;
    onScopeChange: (s: AiScope) => void;
    /** The tab is showing: the conversation scrolls to its newest answer. */
    active: boolean;
    onSelectPage: (pageId: string) => void;
  };

  let { detail, spaceKey, excluded, descendantCount, scope, onScopeChange, active, onSelectPage }: Props = $props();

  const QUICK = [
    {
      label: 'Summary',
      icon: FileText,
      prompt:
        'Provide an executive summary of this documentation with key takeaways, target audience, and primary objectives.',
    },
    {
      label: 'Action items & decisions',
      icon: UserCheck,
      prompt:
        'Extract all action items, decisions made, designated owners, and upcoming milestones from this documentation.',
    },
    {
      label: 'Technical review',
      icon: ShieldCheck,
      prompt:
        'Perform a technical architecture review: analyze component responsibilities, data flow, security considerations, and potential edge cases or failure modes.',
    },
    {
      label: 'Runbook checklist',
      icon: ListOrdered,
      prompt: 'Transform all procedural or operational steps into a concise, numbered runbook checklist.',
    },
    {
      label: 'Explain simply',
      icon: Lightbulb,
      prompt:
        'Explain what this system or documentation describes in simple, beginner-friendly terms without excessive technical jargon.',
    },
  ];
  const UPLOAD_TYPES = '.pdf,.md,.markdown,.txt,.csv,.tsv,.json,.yaml,.yml,.log,.xml,.html,.htm';

  let engine = $state<{ available: boolean; engine: string } | null>(null);
  let input = $state('');
  let raw = $state<Record<number, boolean>>({});
  let copied = $state<number | null>(null);
  let seconds = $state(0);
  let bottom: HTMLDivElement;
  let files: HTMLInputElement;
  const chat = new AiChat();

  const effective = $derived<AiScope>(scope === 'branch' && descendantCount === 0 ? 'page' : scope);
  // The server refuses an excluded page on every route; saying so here saves a round trip.
  const blocked = $derived(excluded && effective !== 'space');
  const subject = $derived(
    effective === 'space'
      ? `space ${spaceKey}`
      : effective === 'branch'
        ? `“${detail.title}” and its ${descendantCount} sub-pages`
        : `“${detail.title}”`,
  );

  $effect(() => {
    chat.open(
      effective === 'space'
        ? { kind: 'space', spaceKey, title: `Space ${spaceKey}` }
        : { kind: effective, spaceKey, pageId: detail.id, title: detail.title },
    );
  });

  $effect(() => {
    api.aiStatus().then(
      (s) => (engine = s),
      () => (engine = { available: false, engine: 'none' }),
    );
  });

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

<div class="ask-ai">
  <div class="panel-bar">
    <Segmented
      label="Ask about"
      value={effective}
      onChange={onScopeChange}
      options={[
        { value: 'page', label: 'This page' },
        {
          value: 'branch',
          label: `With sub-pages${descendantCount ? ` (${descendantCount})` : ''}`,
          disabled: descendantCount === 0,
          title: descendantCount ? 'This page and everything under it' : 'This page has no sub-pages',
        },
        { value: 'space', label: 'Whole space', title: 'The most relevant pages of the synced space' },
      ]}
    />
    <span class="pill pill-plain" title="Choose the AI provider in Settings">
      {engine?.available ? engine.engine : 'No AI configured'}
    </span>
    {#if turns.length > 0}
      <button
        class="btn btn-secondary btn-sm"
        onclick={() => chat.startNew()}
        title="Start a new conversation; this one stays saved"
      >
        <RotateCcw size={12} /> New conversation
      </button>
    {/if}
  </div>

  {#if engine && !engine.available}
    <div class="alert alert-warning">No AI provider is set up. Choose one under Settings → AI provider.</div>
  {/if}
  {#if blocked}
    <div class="alert alert-warning">
      <ShieldOff size={14} /> This page is excluded by <code>.confluenceignore</code>, so it is never sent to an AI. Ask
      about the whole space instead, or change the space's rules.
    </div>
  {/if}

  <div class="quick-actions">
    {#each QUICK as q (q.label)}
      <button class="btn btn-secondary btn-sm" disabled={chat.sending || blocked} onclick={() => ask(q.prompt)}>
        <q.icon size={13} />
        {q.label}
      </button>
    {/each}
  </div>

  <div class="chat-stream">
    {#if turns.length === 0 && !chat.pending}
      <div class="empty-state">
        <Bot size={32} />
        <strong>Ask about {subject}</strong>
        <p>
          Use a quick action above or ask your own question. The conversation is saved and picks up where you left off.
        </p>
      </div>
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
            <div class="chip-row">
              <span class="muted">Pages used:</span>
              {#each t.matchedPages as p (p.id)}
                <button class="pill pill-link" onclick={() => onSelectPage(p.id)} title="Open this page"
                  >{p.title}</button
                >
              {/each}
            </div>
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
          <button type="button" onclick={() => chat.removeFile(f.id)} aria-label="Remove {f.name}"
            ><X size={11} /></button
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
      placeholder="Ask about {subject}…"
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
</div>
