<script lang="ts">
  import { onMount } from 'svelte';

  type Health = { status: string; version: string };

  let health = $state<Health>();
  let error = $state<string>();

  onMount(async () => {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      health = (await res.json()) as Health;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });
</script>

<main>
  <h1>Confluence Explorer</h1>
  {#if health}
    <p>Server is up — version {health.version}.</p>
  {:else if error}
    <p class="error">Could not reach the server: {error}</p>
  {:else}
    <p>Connecting…</p>
  {/if}
</main>

<style>
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: 2rem 1rem;
  }

  .error {
    color: var(--error);
  }
</style>
