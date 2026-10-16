<script lang="ts">
  import { CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, ShieldOff, Sparkles, UploadCloud } from '@lucide/svelte';
  import type { PageResponse, RecommendationResponse, WriteResult } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { bodyOf } from '../support/markdown.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
  import Diff from './ui/Diff.svelte';
  import Markdown from './ui/Markdown.svelte';
  import Segmented from './ui/Segmented.svelte';

  // A proposed revision of this page: reviewed as a diff, editable, dry-run, then pushed after a
  // confirmation. The push names the version the proposal was made from, so an edit made in
  // Confluence since then is never written over.
  type Focus = 'polish' | 'completeness' | 'structure' | 'runbook';
  const FOCUSES: Array<{ value: Focus; label: string }> = [
    { value: 'completeness', label: 'Depth & prerequisites' },
    { value: 'polish', label: 'Clarity & tone' },
    { value: 'structure', label: 'Structure & panels' },
    { value: 'runbook', label: 'Runbook & rollback' },
  ];

  type Props = {
    page: PageResponse;
    spaceKey: string;
    excluded: boolean;
    /** The page was written: reload it, so what is shown is what Confluence now holds. */
    onPushed: () => void;
  };

  let { page, spaceKey, excluded, onPushed }: Props = $props();
  let focus = $state<Focus>('completeness');
  let instructions = $state('');
  let proposal = $state<RecommendationResponse | null>(null);
  let staged = $state('');
  let view = $state<'diff' | 'edit' | 'preview'>('diff');
  let busy = $state<'propose' | 'check' | 'push' | null>(null);
  let checked = $state<{ ok: boolean; message: string } | null>(null);
  let pushed = $state<WriteResult | null>(null);
  let confirming = $state(false);
  const detail = $derived(page.detail);

  async function propose(): Promise<void> {
    busy = 'propose';
    checked = null;
    pushed = null;
    try {
      proposal = await api.recommend(detail.id, {
        spaceKey,
        focusArea: focus,
        prompt: instructions.trim() || undefined,
      });
      staged = proposal.improvedMarkdown;
      view = 'diff';
    } catch (e) {
      toast(`No proposal: ${messageOf(e)}`, 'error');
    } finally {
      busy = null;
    }
  }

  async function dryRun(): Promise<void> {
    if (!proposal) return;
    busy = 'check';
    checked = null;
    try {
      await api.dryRun(detail.id, { markdown: staged, spaceKey, baseVersion: proposal.baseVersion });
      checked = { ok: true, message: 'Dry run passed: Confluence will accept this revision.' };
    } catch (e) {
      checked = { ok: false, message: messageOf(e) };
    } finally {
      busy = null;
    }
  }

  async function push(): Promise<void> {
    if (!proposal) return;
    confirming = false;
    busy = 'push';
    try {
      pushed = await api.push(detail.id, { markdown: staged, spaceKey, baseVersion: proposal.baseVersion });
      // Confluence makes no new version when the text is what it already holds.
      toast(
        pushed.version === proposal.baseVersion
          ? `Confluence already held this text for “${detail.title}”, so no new version was made.`
          : `“${detail.title}” updated to version ${pushed.version}.`,
        pushed.version === proposal.baseVersion ? 'info' : 'success',
      );
      onPushed();
    } catch (e) {
      toast(`Not pushed: ${messageOf(e)}`, 'error');
    } finally {
      busy = null;
    }
  }
</script>

{#if excluded}
  <div class="alert alert-warning">
    <ShieldOff size={14} /> This page is excluded by <code>.confluenceignore</code>, so it is never sent to an AI for a
    proposal.
  </div>
{:else}
  <div class="improve-panel">
    <section class="card">
      <div class="card-head"><h4><Sparkles size={15} /> Propose a revision</h4></div>
      <Segmented label="Focus" value={focus} onChange={(f) => (focus = f)} options={FOCUSES} />
      <div class="row">
        <input
          class="form-input"
          placeholder="Anything specific (optional), e.g. “add troubleshooting for TLS handshake errors”"
          bind:value={instructions}
          disabled={!!busy}
        />
        <button class="btn btn-primary" onclick={propose} disabled={!!busy}>
          {#if busy === 'propose'}<RefreshCw size={14} class="spin" />{:else}<Sparkles size={14} />{/if}
          {busy === 'propose' ? 'Writing…' : proposal ? 'Propose again' : 'Propose'}
        </button>
      </div>
    </section>

    {#if proposal}
      {#if proposal.guard.summary}
        <div class="guard-note" title="Checked by the outbound guard before anything was sent">
          <ShieldCheck size={12} />
          {proposal.guard.summary}
        </div>
      {/if}
      <div class="two-col">
        <section class="card">
          <h4>What could be better</h4>
          <ul class="plain-list">
            {#each proposal.critique as c, i (i)}<li>{c}</li>{/each}
          </ul>
        </section>
        <section class="card">
          <h4>What the revision changes</h4>
          <ul class="plain-list">
            {#each proposal.changelog as c, i (i)}<li>{c}</li>{/each}
          </ul>
        </section>
      </div>

      <section class="card">
        <div class="card-head">
          <Segmented
            label="Revision"
            value={view}
            onChange={(v) => (view = v)}
            options={[
              { value: 'diff', label: 'Changes' },
              { value: 'edit', label: 'Edit' },
              { value: 'preview', label: 'Preview' },
            ]}
          />
          <span class="muted">From version {proposal.baseVersion} · {staged.length.toLocaleString()} characters</span>
        </div>
        {#if view === 'diff'}
          <Diff before={bodyOf(page.parsed.markdown)} after={staged} extraClass="improve-diff" />
        {:else if view === 'edit'}
          <textarea class="form-input code-editor" bind:value={staged}></textarea>
        {:else}
          <Markdown source={staged} extraClass="markdown-preview improve-preview" />
        {/if}
      </section>

      <section class="card">
        <div class="card-head">
          <div>
            <h4>Write to Confluence</h4>
            <p class="muted">
              A dry run checks Confluence will accept it. A push names version {proposal.baseVersion}, and is refused if
              someone changed the page since.
            </p>
          </div>
          <div class="row">
            <button class="btn btn-secondary" onclick={dryRun} disabled={!!busy || !staged.trim()}>
              {#if busy === 'check'}<RefreshCw size={14} class="spin" />{:else}<ShieldCheck size={14} />{/if} Dry run
            </button>
            <button class="btn btn-primary" onclick={() => (confirming = true)} disabled={!!busy || !staged.trim()}>
              {#if busy === 'push'}<RefreshCw size={14} class="spin" />{:else}<UploadCloud size={14} />{/if} Push to Confluence
            </button>
          </div>
        </div>
        {#if checked}<div class={['alert', checked.ok ? 'alert-success' : 'alert-error']}>{checked.message}</div>{/if}
        {#if pushed}
          <div class="alert alert-success">
            <CheckCircle2 size={14} />
            {pushed.version === proposal.baseVersion
              ? 'Nothing to change: Confluence already held this text.'
              : `Pushed as version ${pushed.version}.`}
            {#if detail.webUrl}
              <a href={detail.webUrl} target="_blank" rel="noreferrer" class="btn btn-secondary btn-sm">
                <ExternalLink size={12} /> View in Confluence
              </a>
            {/if}
          </div>
        {/if}
      </section>
    {/if}

    {#if confirming && proposal}
      <ConfirmDialog title="Update this page in Confluence?" onConfirm={push} onCancel={() => (confirming = false)}>
        {#snippet confirmLabel()}<UploadCloud size={14} /> Push{/snippet}
        <p>
          <strong>{detail.title}</strong> goes from version {proposal.baseVersion} to {proposal.baseVersion +
            1}{detail.webUrl ? ` on ${new URL(detail.webUrl).host}` : ''}.
        </p>
        <p class="muted">
          If someone has changed the page since version {proposal.baseVersion}, the push is refused, not written over
          their edit.
        </p>
      </ConfirmDialog>
    {/if}
  </div>
{/if}
