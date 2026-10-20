<script lang="ts">
  import { Download } from '@lucide/svelte';
  import type { ObservedEvent } from '../../../../src/telemetry/query.js';
  import type { SpanRecord } from '../../../../src/telemetry/records.js';
  import { observability } from '../../support/api.js';
  import { observe } from '../../support/observe.svelte.js';
  import { messageOf } from '../../support/toast.svelte.js';

  // One action from start to end: each step as a bar on a shared timeline, so it shows where the time
  // went and where it failed, and each step's details, including what was meant for the model and what
  // reached it (design doc 0008).
  let spans = $state<SpanRecord[]>([]);
  let events = $state<ObservedEvent[]>([]);
  let chosen = $state<SpanRecord | null>(null);
  let error = $state<string | null>(null);
  let typed = $state('');

  $effect(() => {
    const id = observe.traceId;
    if (!id) return;
    observability.trace(id).then(
      (t) => ((spans = t.spans), (events = t.events), (chosen = null), (error = null)),
      (e: unknown) => (error = messageOf(e)),
    );
  });

  // Each span after its parent, children in the order they started, with its depth for indenting.
  const rows = $derived.by(() => {
    const children = new Map<string | undefined, SpanRecord[]>();
    const ids = new Set(spans.map((s) => s.spanId));
    for (const s of spans) {
      const parent = s.parentId && ids.has(s.parentId) ? s.parentId : undefined;
      children.set(parent, [...(children.get(parent) ?? []), s]);
    }
    const out: Array<{ span: SpanRecord; depth: number }> = [];
    const walk = (parent: string | undefined, depth: number): void => {
      for (const s of children.get(parent) ?? []) {
        out.push({ span: s, depth });
        walk(s.spanId, depth + 1);
      }
    };
    walk(undefined, 0);
    return out;
  });
  const start = $derived(Math.min(...spans.map((s) => Date.parse(s.at))));
  const end = $derived(Math.max(...spans.map((s) => Date.parse(s.at) + s.durationMs)));
  const span = $derived(Math.max(1, end - start));
  const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n} ms`);

  function download(): void {
    const blob = new Blob([JSON.stringify({ traceId: observe.traceId, spans, events }, null, 2)], {
      type: 'application/json',
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `confluence-explorer-trace-${observe.traceId}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
</script>

<form
  class="observe-filters"
  onsubmit={(e) => {
    e.preventDefault();
    if (typed.trim()) observe.show('trace', { traceId: typed.trim() });
  }}
>
  <input class="form-input input-sm" placeholder="Trace id" aria-label="Trace id" bind:value={typed} />
  <button class="btn btn-secondary btn-sm">Open</button>
  {#if spans.length}
    <button type="button" class="btn btn-secondary btn-sm" onclick={download}><Download size={12} /> Download</button>
  {/if}
</form>
{#if !observe.traceId}
  <p class="muted">Open a trace from a chat answer, a failed job, a problem or an event, or paste its id above.</p>
{:else if error}
  <div class="alert alert-error">This trace could not be read: {error}</div>
{:else if spans.length === 0}
  <p class="muted">Nothing is recorded for trace {observe.traceId}. Traces are kept for 14 days.</p>
{:else}
  <p class="muted">
    Trace {observe.traceId} · {rows.length} steps · {ms(span)} · started {new Date(start).toLocaleString()}
  </p>
  <div class="observe-waterfall">
    {#each rows as { span: s, depth } (s.spanId)}
      <button
        type="button"
        class={['observe-span', s.outcome, chosen?.spanId === s.spanId && 'chosen']}
        onclick={() => (chosen = s)}
      >
        <span class="observe-span-name" style:padding-left="{depth * 14}px">
          <span class="observe-kind">{s.kind}</span>
          {s.name}
        </span>
        <span class="observe-span-track">
          <span
            class="observe-span-bar"
            style:left="{((Date.parse(s.at) - start) / span) * 100}%"
            style:width="{Math.max(0.5, (s.durationMs / span) * 100)}%"
          ></span>
        </span>
        <span class="observe-span-ms">{ms(s.durationMs)}</span>
      </button>
    {/each}
  </div>
  {#if chosen}
    <section class="observe-card">
      <h4>
        {chosen.kind} · {chosen.name}
        <span class={['observe-level', chosen.outcome === 'error' ? 'error' : 'info']}>{chosen.outcome}</span>
      </h4>
      {#if chosen.error}<div class="alert alert-error">{chosen.error}</div>{/if}
      <pre class="code-viewer-box">{JSON.stringify(chosen.attrs, null, 2)}</pre>
    </section>
  {/if}
  {#if events.length}
    <section class="observe-card">
      <h4>Events in this trace</h4>
      <ul class="observe-list">
        {#each events as e, i (i)}
          <li>
            <span class="muted">{new Date(e.at).toLocaleTimeString()}</span>
            <span class={['observe-level', e.level]}>{e.level}</span>
            <span>{e.message}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/if}
