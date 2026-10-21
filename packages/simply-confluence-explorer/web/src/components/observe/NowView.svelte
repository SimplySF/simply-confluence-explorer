<script lang="ts">
  import { Activity, AlertTriangle, Square } from '@lucide/svelte';
  import { observability, type ObserveNow } from '../../support/api.js';
  import { jobs, type JobKind } from '../../support/jobs.svelte.js';
  import { observe } from '../../support/observe.svelte.js';
  import { messageOf } from '../../support/toast.svelte.js';
  import LineChart from './LineChart.svelte';

  // Whether the app is working or stuck, right now: what is running, what is waiting on the server,
  // whether the server can answer at all, and the last day's health (design doc 0008).
  let now = $state<ObserveNow | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    let live = true;
    const load = (): void => {
      observability.now().then(
        (n) => live && ((now = n), (error = null)),
        (e: unknown) => live && (error = messageOf(e)),
      );
    };
    load();
    const timer = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  });

  const STOP_KIND: Record<string, JobKind> = { index: 'summaries', sync: 'sync', batch: 'batch' };
  const lagState = (ms: number): string => (ms >= 2000 ? 'frozen' : ms >= 200 ? 'slow' : 'answering');
  const series = (
    name: string,
    color: string,
    key: string,
  ): { name: string; color: string; values: Array<{ t: number; v: number }> } => ({
    name,
    color,
    values: (now?.points ?? []).map((p) => ({ t: Date.parse(p.at), v: p.values[key] ?? 0 })),
  });
  // The charts start at the first number kept, at least an hour back and at most a day, so a few
  // minutes of data are spread out rather than squeezed against the right edge.
  const to = $derived(now ? Date.now() : 0);
  const from = $derived(
    Math.max(to - 24 * 3_600_000, Math.min(Date.parse(now?.points[0]?.at ?? '') || to, to - 3_600_000)),
  );
  const rate = (j: ObserveNow['jobs'][number]): string => {
    if (!j.startedAt || j.processed === 0) return '';
    const minutes = (Date.now() - Date.parse(j.startedAt)) / 60_000;
    const perMinute = j.processed / Math.max(minutes, 1 / 60);
    const left = j.total > j.processed ? (j.total - j.processed) / perMinute : 0;
    return `${perMinute.toFixed(1)}/min${left ? ` · about ${left < 90 ? `${Math.ceil(left)} min` : `${(left / 60).toFixed(1)} h`} left` : ''}`;
  };
</script>

{#if error}<div class="alert alert-error">The server did not answer: {error}</div>{/if}
{#if now}
  <div class="observe-now">
    <section class={['observe-card', 'observe-health', lagState(now.lagMs.max)]}>
      <Activity size={16} />
      <div>
        <strong>The server is {lagState(now.lagMs.max)}</strong>
        <span class="muted">Longest wait in the last few seconds: {now.lagMs.max} ms (typical {now.lagMs.p50} ms)</span>
      </div>
    </section>

    {#if now.problems.length}
      <section class="observe-card">
        <h4><AlertTriangle size={14} /> Problems</h4>
        <ul class="observe-list">
          {#each [...now.problems].reverse() as p (p.at + p.message)}
            <li class={{ unseen: p.at > observe.seenAt }}>
              <span class="muted">{new Date(p.at).toLocaleString()}</span>
              <span>{p.message}</span>
              {#if p.traceId}
                <button type="button" class="link-btn" onclick={() => observe.show('trace', { traceId: p.traceId })}
                  >Trace</button
                >
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="observe-card">
      <h4>Running</h4>
      {#each now.jobs as j (j.jobId)}
        <div class="observe-job">
          <div>
            <strong>{j.label}</strong>
            <span class="muted">{j.processed}/{j.total || '?'} {rate(j)}{j.current ? ` · on ${j.current}` : ''}</span>
          </div>
          <progress max={j.total || 1} value={j.processed}></progress>
          {#if STOP_KIND[j.kind]}
            <button
              type="button"
              class="btn btn-secondary btn-xs"
              onclick={() =>
                jobs.stop({
                  kind: STOP_KIND[j.kind],
                  jobId: j.jobId,
                  spaceKey: '',
                  label: j.label,
                  processed: 0,
                  total: 0,
                })}><Square size={11} /> Stop</button
            >
          {/if}
        </div>
      {:else}
        <p class="muted">Nothing is running in the background.</p>
      {/each}
      {#if now.inflight.length}
        <h4>Waiting on the server</h4>
        <ul class="observe-list">
          {#each now.inflight as r (r.traceId)}
            <li>
              <span>{r.method} {r.path}</span>
              <span class="muted">{(r.ms / 1000).toFixed(1)} s</span>
              <button type="button" class="link-btn" onclick={() => observe.show('trace', { traceId: r.traceId })}
                >Trace</button
              >
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="observe-charts">
      <LineChart
        title="Longest wait for the server, each minute"
        unit="ms"
        {from}
        {to}
        series={[series('Wait', 'var(--accent-primary)', 'lagMaxMs')]}
      />
      <LineChart
        title="AI requests each minute"
        unit=""
        {from}
        {to}
        series={[
          series('Requests', 'var(--accent-primary)', 'ai.requests'),
          series('Failed', 'var(--status-error)', 'ai.failures'),
        ]}
      />
      <LineChart
        title="Pages indexed each minute"
        unit=""
        {from}
        {to}
        series={[series('Pages', 'var(--accent-primary)', 'index.pages')]}
      />
    </section>
  </div>
{/if}
