<script lang="ts">
  import { Activity, X } from '@lucide/svelte';
  import { observe, type ObserveTab } from '../../support/observe.svelte.js';
  import Segmented from '../ui/Segmented.svelte';
  import LogsView from './LogsView.svelte';
  import NowView from './NowView.svelte';
  import TraceView from './TraceView.svelte';

  // The Observability page: what is happening now, what was recorded, and one action traced through
  // (design doc 0008). It has its own address, so it can be kept open in another tab.
</script>

<div class="observe-page">
  <div class="observe-head">
    <h3><Activity size={16} /> Observability</h3>
    <Segmented
      label="View"
      value={observe.tab}
      onChange={(tab: ObserveTab) => observe.show(tab)}
      options={[
        { value: 'now', label: 'Now', title: 'What is running, and whether the server is answering' },
        { value: 'logs', label: 'Logs', title: 'What the app recorded, with counts to filter by' },
        { value: 'trace', label: 'Trace', title: 'One action from start to end' },
      ]}
    />
    <button type="button" class="btn btn-secondary btn-sm" onclick={() => observe.close()}><X size={13} /> Close</button
    >
  </div>
  {#if observe.tab === 'now'}
    <NowView />
  {:else if observe.tab === 'logs'}
    <LogsView />
  {:else}
    <TraceView />
  {/if}
</div>
