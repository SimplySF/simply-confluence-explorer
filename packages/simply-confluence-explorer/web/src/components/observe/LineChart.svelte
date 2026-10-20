<script lang="ts">
  // A small line chart over time, drawn as SVG with no chart library (design doc 0008). Hovering shows
  // a crosshair and every series' value at that minute; a table holds the same numbers for anyone
  // who cannot or would rather not hover. Two or more series get a legend, so identity never rests on
  // colour alone.
  type Series = { name: string; color: string; values: Array<{ t: number; v: number }> };
  type Props = { title: string; unit: string; series: Series[]; from: number; to: number };

  let { title, unit, series, from, to }: Props = $props();
  // Close to the size it is shown at, so its text stays readable rather than shrinking with the drawing.
  const W = 380;
  const H = 130;
  const PAD = { left: 34, right: 40, top: 10, bottom: 20 };
  let hover = $state<number | null>(null);
  let table = $state(false);

  const max = $derived(niceMax(Math.max(1, ...series.flatMap((s) => s.values.map((p) => p.v)))));
  const x = (t: number): number => PAD.left + ((t - from) / Math.max(1, to - from)) * (W - PAD.left - PAD.right);
  const y = (v: number): number => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
  const times = $derived([...new Set(series.flatMap((s) => s.values.map((p) => p.t)))].sort((a, b) => a - b));
  const empty = $derived(times.length === 0);
  const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmt = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(Math.round(v * 10) / 10));

  function niceMax(v: number): number {
    const step = 10 ** Math.floor(Math.log10(v));
    return Math.ceil(v / step) * step;
  }

  function path(s: Series): string {
    return s.values.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  }

  function track(e: PointerEvent): void {
    const svg = e.currentTarget as SVGSVGElement;
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best: number | null = null;
    for (const t of times) if (best === null || Math.abs(x(t) - px) < Math.abs(x(best) - px)) best = t;
    hover = best;
  }

  const valueAt = (s: Series, t: number): number | undefined => s.values.find((p) => p.t === t)?.v;
</script>

<figure class="line-chart">
  <figcaption>
    <span class="line-chart-title">{title}</span>
    {#if series.length > 1}
      <span class="line-chart-legend">
        {#each series as s (s.name)}<span><i style:background={s.color}></i>{s.name}</span>{/each}
      </span>
    {/if}
    <button type="button" class="link-btn" onclick={() => (table = !table)}>{table ? 'Chart' : 'Table'}</button>
  </figcaption>
  {#if empty}
    <p class="muted line-chart-empty">No numbers yet. They are kept once a minute while the app runs.</p>
  {:else if table}
    <div class="line-chart-table">
      <table class="data-table">
        <thead
          ><tr
            ><th>Time</th>{#each series as s (s.name)}<th>{s.name} ({unit})</th>{/each}</tr
          ></thead
        >
        <tbody>
          {#each [...times].reverse().slice(0, 60) as t (t)}
            <tr
              ><td>{clock(t)}</td>{#each series as s (s.name)}<td>{fmt(valueAt(s, t) ?? 0)}</td>{/each}</tr
            >
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="line-chart-plot">
      <svg
        viewBox="0 0 {W} {H}"
        role="img"
        aria-label="{title}, over the time shown"
        onpointermove={track}
        onpointerleave={() => (hover = null)}
      >
        {#each [0, 0.5, 1] as f (f)}
          <line class="grid" x1={PAD.left} x2={W - PAD.right} y1={y(max * f)} y2={y(max * f)} />
          <text class="axis" x={PAD.left - 6} y={y(max * f) + 3} text-anchor="end">{fmt(max * f)}</text>
        {/each}
        <text class="axis" x={PAD.left} y={H - 6}
          >{to - from >= 7_200_000
            ? `${Math.round((to - from) / 3_600_000)} h ago`
            : `${Math.round((to - from) / 60_000)} min ago`}</text
        >
        <text class="axis" x={W - PAD.right} y={H - 6} text-anchor="end">now</text>
        {#each series as s (s.name)}
          <path
            d={path(s)}
            fill="none"
            stroke={s.color}
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          {@const last = s.values.at(-1)}
          {#if last}
            <circle cx={x(last.t)} cy={y(last.v)} r="4" fill={s.color} class="end-dot" />
            <text class="end-label" x={x(last.t) + 8} y={y(last.v) + 3}>{fmt(last.v)}</text>
          {/if}
        {/each}
        {#if hover !== null}
          <line class="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} />
        {/if}
        <rect class="hit" x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right} height={H - PAD.top - PAD.bottom} />
      </svg>
      {#if hover !== null}
        <div class="line-chart-tip" style:left="{(x(hover) / W) * 100}%">
          <span class="muted">{clock(hover)}</span>
          {#each series as s (s.name)}
            <span><i style:background={s.color}></i><strong>{fmt(valueAt(s, hover) ?? 0)} {unit}</strong> {s.name}</span
            >
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</figure>
