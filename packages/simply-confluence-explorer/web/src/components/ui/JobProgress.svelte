<script lang="ts">
  import { XCircle } from '@lucide/svelte';

  // A running job: how far it is, what it is on, and a way to stop it. A job that cannot count its
  // progress, such as one request to an AI, shows a moving bar and how long it has been running.
  type Props = {
    processed: number;
    total: number;
    current?: string;
    /** When the job started, for the time shown while its progress cannot be counted. */
    startedAt?: string;
    onStop?: () => void;
    stopLabel?: string;
  };

  let { processed, total, current, startedAt, onStop, stopLabel = 'Stop' }: Props = $props();
  const counted = $derived(total > 0);
  const percent = $derived(counted ? Math.round((processed / total) * 100) : 0);

  let now = $state(Date.now());
  $effect(() => {
    if (counted || !startedAt) return;
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const elapsed = $derived.by(() => {
    if (!startedAt) return '';
    const s = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
</script>

<div class="job-progress">
  {#if counted}
    <div class="job-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div class="job-progress-fill" style:width="{percent}%"></div>
    </div>
    <span class="job-progress-label" title={current}>{processed}/{total}{current ? `: ${current}` : ''}</span>
  {:else}
    <div class="job-progress-track" role="progressbar" aria-label={current ?? 'Working'}>
      <div class="job-progress-fill job-progress-moving"></div>
    </div>
    <span class="job-progress-label" title={current}>{current ?? 'Working'}{elapsed ? ` · ${elapsed}` : ''}</span>
  {/if}
  {#if onStop}
    <button type="button" class="btn btn-secondary btn-sm btn-danger-text" onclick={onStop}>
      <XCircle size={12} />
      {stopLabel}
    </button>
  {/if}
</div>
