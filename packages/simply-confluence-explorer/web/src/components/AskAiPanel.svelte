<script lang="ts" module>
  export type AiScope = 'page' | 'branch';
</script>

<script lang="ts">
  import { Bot, FileText, Lightbulb, ListOrdered, RotateCcw, ShieldCheck, ShieldOff, UserCheck } from '@lucide/svelte';
  import type { PageDetail } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { AiChat } from '../support/chat.svelte.js';
  import ChatThread from './ChatThread.svelte';
  import Segmented from './ui/Segmented.svelte';

  // One conversation with the AI about a page, or the page and everything under it. A question about
  // the whole space is asked in Space chat (ADR-046).
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

  let engine = $state<{ available: boolean; engine: string } | null>(null);
  const chat = new AiChat();

  const effective = $derived<AiScope>(scope === 'branch' && descendantCount === 0 ? 'page' : scope);
  // The server refuses an excluded page on every route; saying so here saves a round trip.
  const blocked = $derived(excluded);
  const subject = $derived(
    effective === 'branch' ? `“${detail.title}” and its ${descendantCount} sub-pages` : `“${detail.title}”`,
  );

  $effect(() => {
    chat.open({ kind: effective, spaceKey, pageId: detail.id, title: detail.title });
  });

  $effect(() => {
    api.aiStatus().then(
      (s) => (engine = s),
      () => (engine = { available: false, engine: 'none' }),
    );
  });

  function ask(prompt: string): void {
    if (!chat.sending && !blocked) void chat.send(prompt);
  }

  const turns = $derived(chat.session?.turns ?? []);
</script>

<div class="ask-ai">
  <div class="panel-bar">
    <Segmented
      label="Ask about"
      value={effective}
      onChange={onScopeChange}
      options={[
        {
          value: 'branch',
          label: `With sub-pages${descendantCount ? ` (${descendantCount})` : ''}`,
          disabled: descendantCount === 0,
          title: descendantCount ? 'This page and everything under it' : 'This page has no sub-pages',
        },
        { value: 'page', label: 'This page' },
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
      about the whole space in Space chat instead, or change the space's rules.
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

  <ChatThread {chat} {subject} {blocked} {active} {onSelectPage}>
    {#snippet empty()}
      <Bot size={32} />
      <strong>Ask about {subject}</strong>
      <p>
        Use a quick action above or ask your own question. The conversation is saved and picks up where you left off.
      </p>
    {/snippet}
  </ChatThread>
</div>
