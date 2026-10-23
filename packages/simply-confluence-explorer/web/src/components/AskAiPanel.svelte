<script lang="ts" module>
  export type AiScope = 'page' | 'branch';
</script>

<script lang="ts">
  import {
    Bot,
    FileText,
    Lightbulb,
    ListOrdered,
    RotateCcw,
    Search,
    ShieldCheck,
    ShieldOff,
    UserCheck,
  } from '@lucide/svelte';
  import type { BranchFinding, PageDetail } from '../../../src/api/types.js';
  import { api, type Coverage } from '../support/api.js';
  import { chatWaiting } from '../support/pages.js';
  import { AiChat } from '../support/chat.svelte.js';
  import { type Starter } from './ChatThread.svelte';
  import ChatWorkspace from './ChatWorkspace.svelte';
  import AttachmentsNote from './AttachmentsNote.svelte';
  import SummaryCoverage from './SummaryCoverage.svelte';
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
    /** Pages were written from a queue, so the tree and the page reload. */
    onPushed: () => void;
    onWriteNewPage: (finding: BranchFinding) => void;
    /** How many suggestions wait to be recommended, for the page's tab to count. */
    onOpenCount?: (n: number) => void;
  };

  let {
    detail,
    spaceKey,
    excluded,
    descendantCount,
    scope,
    onScopeChange,
    active,
    onSelectPage,
    onPushed,
    onWriteNewPage,
    onOpenCount,
  }: Props = $props();

  // Questions to begin with, offered beside the review until the first question is asked.
  const QUICK: Starter[] = [
    {
      label: 'Summary',
      detail: 'Key takeaways, who it is for, and what it sets out to do.',
      icon: FileText,
      prompt:
        'Provide an executive summary of this documentation with key takeaways, target audience, and primary objectives.',
    },
    {
      label: 'Action items & decisions',
      detail: 'The decisions, owners and dates it records.',
      icon: UserCheck,
      prompt:
        'Extract all action items, decisions made, designated owners, and upcoming milestones from this documentation.',
    },
    {
      label: 'Technical review',
      detail: 'Responsibilities, data flow, security and failure modes.',
      icon: ShieldCheck,
      prompt:
        'Perform a technical architecture review: analyze component responsibilities, data flow, security considerations, and potential edge cases or failure modes.',
    },
    {
      label: 'Runbook checklist',
      detail: 'Its operational steps as a numbered checklist.',
      icon: ListOrdered,
      prompt: 'Transform all procedural or operational steps into a concise, numbered runbook checklist.',
    },
    {
      label: 'Explain simply',
      detail: 'What it describes, without the jargon.',
      icon: Lightbulb,
      prompt:
        'Explain what this system or documentation describes in simple, beginner-friendly terms without excessive technical jargon.',
    },
  ];

  let engine = $state<{ available: boolean; engine: string } | null>(null);
  // What the chat's pages hold, shared by the scope bar's count and the attachments note under it.
  let counts = $state<Coverage | null>(null);
  let checking = $state(false);
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

  const review = $derived<Starter>(
    effective === 'branch'
      ? {
          label: 'Review for problems',
          detail:
            'Repeats, contradictions, out-of-date and missing pages across these pages, as suggestions in the review queue.',
          icon: Search,
          review: true,
        }
      : {
          label: 'Suggest improvements',
          detail: 'Clarity, missing detail and structure, as suggestions in the review queue.',
          icon: Search,
          review: true,
        },
  );

  const turns = $derived(chat.session?.turns ?? []);
</script>

<div class="ask-ai">
  <ChatWorkspace
    {chat}
    {subject}
    {blocked}
    {active}
    {onSelectPage}
    {onPushed}
    {onWriteNewPage}
    {onOpenCount}
    waiting={blocked ? undefined : chatWaiting({ checking, counts })}
    starters={[review, ...QUICK]}
  >
    {#snippet top()}
      <div class="scope-bar">
        <span>Asking about</span>
        <Segmented
          label="Ask about"
          value={effective}
          onChange={onScopeChange}
          options={[
            {
              value: 'branch',
              label: descendantCount
                ? `This page + ${descendantCount} sub-page${descendantCount === 1 ? '' : 's'}`
                : 'With sub-pages',
              disabled: descendantCount === 0,
              title: descendantCount ? 'This page and everything under it' : 'This page has no sub-pages',
            },
            { value: 'page', label: 'This page only' },
          ]}
        />
        <span class="spacer"></span>
        {#if !blocked}
          <SummaryCoverage
            {spaceKey}
            rootPageId={effective === 'branch' ? detail.id : undefined}
            chosen={effective === 'page' ? { pageIds: [detail.id] } : undefined}
            {chat}
            bind:counts
            bind:checking
          />
        {/if}
        <span class="pill pill-plain" title="Choose the AI provider in Settings">
          {engine?.available ? engine.engine : 'No AI configured'}
        </span>
        {#if turns.length > 0}
          <button
            class="btn-icon btn-icon-sm"
            onclick={() => chat.startNew()}
            title="New conversation; this one stays saved"
            aria-label="New conversation"
          >
            <RotateCcw size={13} />
          </button>
        {/if}
      </div>
    {/snippet}
    {#snippet notes()}
      {#if engine && !engine.available}
        <div class="alert alert-warning">No AI provider is set up. Choose one under Settings → AI provider.</div>
      {/if}
      {#if blocked}
        <div class="alert alert-warning">
          <ShieldOff size={14} /> This page is excluded by <code>.confluenceignore</code>, so it is never sent to an AI.
          Ask about the whole space in Space chat instead, or change the space's rules.
        </div>
      {/if}
      {#if !blocked && checking && !counts?.attachments}
        <div class="attachments-note muted" role="status">
          <span class="spinner" aria-hidden="true"></span> Checking these pages' attachments…
        </div>
      {:else if !blocked && counts?.attachments}
        <AttachmentsNote {spaceKey} report={counts.attachments} {chat} before />
      {/if}
    {/snippet}
    {#snippet empty()}
      <Bot size={32} />
      <strong>Ask about {subject}</strong>
      <p>
        Start with one of these, or ask your own question below. The conversation is saved and picks up where you left
        off; <strong>New conversation</strong>, beside the AI's name above, brings these back.
      </p>
    {/snippet}
  </ChatWorkspace>
</div>
