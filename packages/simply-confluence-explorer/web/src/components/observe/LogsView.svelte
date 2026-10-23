<script lang="ts">
  import { Download, Search } from '@lucide/svelte';
  import type { LogPage, ObservedEvent } from '../../../../src/telemetry/query.js';
  import { observability } from '../../support/api.js';
  import { observe } from '../../support/observe.svelte.js';
  import { messageOf } from '../../support/toast.svelte.js';

  // The events the app recorded: what went wrong and what it did, filtered by clicking counts, with
  // repeated messages grouped so one failure copied 300 times reads as one (design doc 0008).
  const RANGES = ['15m', '1h', '24h', '7d', '14d'];
  let range = $state(observe.filter.range ?? '24h');
  let levels = $state<string[]>(observe.filter.levels ?? []);
  let kinds = $state<string[]>(observe.filter.kinds ?? []);
  let spaceKey = $state(observe.filter.spaceKey ?? '');
  let text = $state(observe.filter.q ?? '');
  let tail = $state(true);
  let page = $state<LogPage | null>(null);
  let more = $state<ObservedEvent[]>([]);
  let error = $state<string | null>(null);
  let open = $state<Record<number, boolean>>({});

  const params = (): Record<string, string> => ({
    range,
    ...(levels.length ? { level: levels.join(',') } : {}),
    ...(kinds.length ? { kind: kinds.join(',') } : {}),
    ...(spaceKey ? { spaceKey } : {}),
    ...(text.trim() ? { q: text.trim() } : {}),
  });

  $effect(() => {
    const query = params();
    void tail;
    let live = true;
    const load = (): void => {
      observability.logs(query).then(
        (p) => live && ((page = p), (more = []), (error = null)),
        (e: unknown) => live && (error = messageOf(e)),
      );
    };
    const delay = setTimeout(load, 250);
    const timer = tail ? setInterval(load, 3000) : undefined;
    return () => {
      live = false;
      clearTimeout(delay);
      clearInterval(timer);
    };
  });

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  const events = $derived([...(page?.events ?? []), ...more]);

  async function loadMore(): Promise<void> {
    const before = (more.at(-1) ?? page?.events.at(-1))?.at;
    if (!before) return;
    tail = false;
    const next = await observability.logs({ ...params(), before });
    more = [...more, ...next.events];
  }

  function download(): void {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `confluence-explorer-logs-${new Date().toISOString().slice(0, 16)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
</script>

<div class="observe-filters">
  <select class="form-input input-sm" bind:value={range} aria-label="Time range">
    {#each RANGES as r (r)}<option value={r}>Last {r}</option>{/each}
  </select>
  <div class="search-field">
    <Search size={13} />
    <input class="form-input input-sm" placeholder="Search messages" aria-label="Search messages" bind:value={text} />
  </div>
  <label class="observe-tail"><input type="checkbox" bind:checked={tail} /> Live</label>
  <button type="button" class="btn btn-secondary btn-sm" onclick={download} disabled={!events.length}
    ><Download size={12} /> Download</button
  >
</div>
{#if error}<div class="alert alert-error">The server did not answer: {error}</div>{/if}
{#if !page && !error}
  <p class="muted observe-loading" role="status">
    <span class="spinner" aria-hidden="true"></span> Reading the recorded events…
  </p>
{/if}
{#if page}
  <div class="observe-logs">
    <aside class="observe-facets">
      {#each [['Level', 'level', levels], ['Kind', 'kind', kinds]] as [label, facet, chosen] (facet)}
        <h5>{label}</h5>
        {#each Object.entries(page.facets[facet as 'level' | 'kind']).sort((a, b) => b[1] - a[1]) as [value, count] (value)}
          <label>
            <input
              type="checkbox"
              checked={(chosen as string[]).includes(value)}
              onchange={() => (facet === 'level' ? (levels = toggle(levels, value)) : (kinds = toggle(kinds, value)))}
            />
            {value} <span class="muted">{count}</span>
          </label>
        {/each}
      {/each}
      {#if Object.keys(page.facets.space).length}
        <h5>Space</h5>
        {#each Object.entries(page.facets.space) as [value, count] (value)}
          <label>
            <input type="radio" name="observe-space" checked={spaceKey === value} onchange={() => (spaceKey = value)} />
            {value} <span class="muted">{count}</span>
          </label>
        {/each}
        {#if spaceKey}<button type="button" class="link-btn" onclick={() => (spaceKey = '')}>Every space</button>{/if}
      {/if}
    </aside>
    <div class="observe-events">
      {#if page.groups.length}
        <details class="observe-groups">
          <summary>Repeated messages ({page.groups.length})</summary>
          <ul class="observe-list">
            {#each page.groups as g (g.level + g.kind + g.message)}
              <li>
                <span class="observe-count">{g.count}×</span>
                <span class={['observe-level', g.level]}>{g.level}</span>
                <span>{g.message}</span>
                <span class="muted"
                  >{new Date(g.first).toLocaleTimeString()}–{new Date(g.last).toLocaleTimeString()}</span
                >
              </li>
            {/each}
          </ul>
        </details>
      {/if}
      {#each events as e, i (i)}
        <div class="observe-event">
          <button
            type="button"
            class="observe-event-row"
            onclick={() => (open[i] = !open[i])}
            aria-expanded={!!open[i]}
          >
            <span class="muted">{new Date(e.at).toLocaleString()}</span>
            <span class={['observe-level', e.level]}>{e.level}</span>
            <span class="observe-kind">{e.kind}</span>
            <span class="observe-message">{e.message}</span>
          </button>
          {#if open[i]}
            <div class="observe-event-detail">
              {#if e.attrs}<pre class="code-viewer-box">{JSON.stringify(e.attrs, null, 2)}</pre>{/if}
              {#if e.traceId}
                <button
                  type="button"
                  class="btn btn-secondary btn-xs"
                  onclick={() => observe.show('trace', { traceId: e.traceId })}>Open its trace</button
                >
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <p class="muted">Nothing recorded in this range matches.</p>
      {/each}
      {#if page.next}<button type="button" class="btn btn-secondary btn-sm" onclick={loadMore}>Older events</button
        >{/if}
    </div>
  </div>
{/if}
