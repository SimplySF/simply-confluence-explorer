<script lang="ts">
  import { XCircle } from '@lucide/svelte';

  // A running job: how far it is, what it is on, and a way to stop it.
  type Props = { processed: number; total: number; current?: string; onStop?: () => void; stopLabel?: string };

  let { processed, total, current, onStop, stopLabel = 'Stop' }: Props = $props();
  const percent = $derived(total > 0 ? Math.round((processed / total) * 100) : 0);
</script>

<div class="job-progress">
  <div class="job-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
    <div class="job-progress-fill" style:width="{percent}%"></div>
  </div>
  <span class="job-progress-label" title={current}>{processed}/{total}{current ? `: ${current}` : ''}</span>
  {#if onStop}
    <button type="button" class="btn btn-secondary btn-sm btn-danger-text" onclick={onStop}>
      <XCircle size={12} />
      {stopLabel}
    </button>
  {/if}
</div>
