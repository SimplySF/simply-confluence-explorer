<script lang="ts">
  import { Loader2 } from '@lucide/svelte';
  import { jobs, type Job } from '../support/jobs.svelte.js';

  // What is running in the background, wherever the person is in the app; each one opens where it started.
  type Props = { onOpen: (job: Job) => void };

  let { onOpen }: Props = $props();
</script>

{#if jobs.list.length > 0}
  <div class="jobs-bar" aria-live="polite">
    {#each jobs.list as job (job.jobId)}
      <button
        type="button"
        class="jobs-bar-item"
        title="{job.label}{job.current ? `, on ${job.current}` : ''}. Click to open."
        onclick={() => onOpen(job)}
      >
        <Loader2 size={12} class="spin" />
        <span class="jobs-bar-label">{job.label}</span>
        {#if job.total > 0}<span class="jobs-bar-count">{job.processed}/{job.total}</span>{/if}
      </button>
    {/each}
  </div>
{/if}
