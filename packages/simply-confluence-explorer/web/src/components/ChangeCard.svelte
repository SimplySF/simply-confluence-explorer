<script lang="ts">
  import { AlertTriangle, Ban, Check, RotateCcw } from '@lucide/svelte';
  import type { PageChange } from '../../../src/api/types.js';
  import { wordDiff, type WordPiece } from '../support/lineDiff.js';
  import { partPieces, type Pictures } from '../support/markdown.js';

  // One change of a page's edit: the text it replaces and the text it puts there, with the words that
  // differ marked, what else accepting it does, and the person's decision on it (ADR-059). Side by
  // side, the page's text is on the left, the edit's on the right, and the decision between them.
  type Props = {
    change: PageChange;
    busy: boolean;
    onDecide: (decision: 'accept' | 'reject' | 'undo') => void;
    columns?: boolean;
    pictures?: Pictures;
  };

  let { change, busy, onDecide, columns = false, pictures = {} }: Props = $props();
  const pictureOf = (marker: string): string | undefined => pictures[Number(/^⟦(\d+)/.exec(marker)?.[1])];
  const words = $derived(wordDiff(change.before, change.after));
  const kind = $derived(!change.before ? 'Adds' : !change.after ? 'Removes' : 'Changes');
  const wordClass = (w: WordPiece): string | undefined => (w.kind === 'changed' ? 'word-changed' : undefined);
</script>

{#snippet side(pieces: WordPiece[], cls: string)}
  <div class="change-text {cls}">
    {#each pieces as w, n (n)}{#each partPieces(w.text) as p, k (k)}{#if p.part}{#if pictureOf(p.text)}<span
              class="part-picture"
              ><img src={pictureOf(p.text)} alt={p.text.slice(1, -1)} loading="lazy" /><span class="part-chip"
                >{p.text.slice(1, -1)}</span
              ></span
            >{:else}<span class="part-chip">{p.text.slice(1, -1)}</span>{/if}{:else}<span class={wordClass(w)}
            >{p.text}</span
          >{/if}{/each}{/each}
  </div>
{/snippet}

{#snippet actions()}
  <div class="branch-actions">
    {#if change.decision === 'pending'}
      <button class="btn btn-primary btn-sm" disabled={busy || !!change.problem} onclick={() => onDecide('accept')}>
        <Check size={13} /> Accept
      </button>
      <button class="btn btn-secondary btn-sm" disabled={busy} onclick={() => onDecide('reject')}>
        <Ban size={13} /> Reject
      </button>
    {:else}
      <button class="btn btn-secondary btn-sm" disabled={busy} onclick={() => onDecide('undo')}>
        <RotateCcw size={13} /> Undo
      </button>
    {/if}
  </div>
{/snippet}

<div class="change-card decision-{change.decision}">
  <div class="change-head">
    <span class="change-kind">{kind}</span>
    <span class="change-source">{change.source === 'ai' ? 'Suggested by the AI' : 'Your edit'}</span>
    {#if change.decision !== 'pending'}
      <span class="change-decision">{change.decision === 'accepted' ? 'Accepted' : 'Rejected'}</span>
    {/if}
  </div>
  {#if columns}
    <div class="change-row">
      {@render side(words.before, 'change-before')}
      <div class="change-gutter">{@render actions()}</div>
      {@render side(words.after, 'change-after')}
    </div>
  {:else}
    {#if change.before}{@render side(words.before, 'change-before')}{/if}
    {#if change.after}{@render side(words.after, 'change-after')}{/if}
  {/if}
  {#each change.notes as note (note)}<p class="change-note"><AlertTriangle size={12} /> {note}</p>{/each}
  {#if change.problem}<p class="branch-error">{change.problem}</p>{/if}
  {#if !columns}{@render actions()}{/if}
</div>
