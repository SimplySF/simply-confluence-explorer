<script lang="ts">
  import { FilePlus2 } from '@lucide/svelte';
  import type { BranchFinding } from '../../../src/api/types.js';

  // A review's suggestions, each with a tick box. Only suggestions an edit can carry out can be
  // ticked; one that needs a page moved, split, merged or written says so instead (ADR-046).
  type Props = {
    findings: BranchFinding[];
    /** The pages the review read, by title, so a page a suggestion names can be opened. */
    pageIds: Record<string, string>;
    chosen: Set<number>;
    onChange: (chosen: Set<number>) => void;
    onOpenPage: (pageId: string) => void;
    /** A suggestion for a page that does not exist yet: start writing it. */
    onWriteNewPage?: (finding: BranchFinding) => void;
  };

  let { findings, pageIds, chosen, onChange, onOpenPage, onWriteNewPage }: Props = $props();

  const KIND_LABEL: Record<BranchFinding['kind'], string> = {
    incorrect: 'Incorrect or contradictory',
    redundant: 'Repeated',
    stale: 'Out of date',
    clarity: 'Unclear',
    depth: 'Missing detail',
    structure: 'Structure',
    operations: 'Runbook',
    placement: 'In the wrong place',
    gap: 'Missing page',
  };
  const editable = (f: BranchFinding): boolean => f.kind !== 'placement' && f.kind !== 'gap' && f.pages.length > 0;
  const choosable = $derived(findings.flatMap((f, i) => (editable(f) ? [i] : [])));

  function toggle(i: number): void {
    const next = new Set(chosen);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    onChange(next);
  }
</script>

{#if findings.length === 0}
  <p class="muted">No problems found.</p>
{:else}
  <div class="review-findings-head">
    <label class="review-check">
      <input
        type="checkbox"
        checked={choosable.length > 0 && choosable.every((i) => chosen.has(i))}
        disabled={choosable.length === 0}
        onchange={(e) => onChange(new Set(e.currentTarget.checked ? choosable : []))}
      />
      Select all
    </label>
    <span class="branch-note">{chosen.size} of {choosable.length} chosen</span>
  </div>
  {#each findings as f, i (i)}
    <div class="branch-finding kind-{f.kind}">
      <label class="review-check">
        {#if editable(f)}
          <input type="checkbox" checked={chosen.has(i)} onchange={() => toggle(i)} />
        {/if}
        <strong>{KIND_LABEL[f.kind]}</strong>
      </label>
      {#if f.pages.length > 0}
        ·
        {#each f.pages as p, n (n)}
          {n > 0 ? ', ' : ''}
          {#if pageIds[p]}
            <button class="link-btn" onclick={() => onOpenPage(pageIds[p])} title="Open this page">{p}</button>
          {:else}
            {p}
          {/if}
        {/each}
      {/if}
      <p>{f.detail}</p>
      {#if f.suggestion}<p class="branch-suggestion">→ {f.suggestion}</p>{/if}
      {#if !editable(f)}
        <p class="branch-note">
          {f.kind === 'gap'
            ? 'This needs a new page, so it cannot be applied as an edit.'
            : 'This needs a page moved, split or merged: do it in Confluence.'}
          {#if f.kind === 'gap' && onWriteNewPage}
            <button class="btn btn-secondary btn-sm" onclick={() => onWriteNewPage(f)}>
              <FilePlus2 size={12} /> Write a new page
            </button>
          {/if}
        </p>
      {/if}
    </div>
  {/each}
{/if}
