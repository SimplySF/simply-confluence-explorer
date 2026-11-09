<script lang="ts">
  import { ArrowLeft, Search, ShieldOff } from '@lucide/svelte';
  import type { DirectoryStats } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { messageOf } from '../support/toast.svelte.js';
  import Segmented from './ui/Segmented.svelte';

  // The Space map over the whole window (design doc 0017): every directory with how much sits below
  // it, so a large cache of old pages, such as a release note for every build, is found at a glance.
  // A row opens its page, or proposes an exclusion rule for the person to save.
  type Props = {
    spaceKey: string;
    onExit: () => void;
    onSelectPage: (pageId: string) => void;
    onExclude: (rule: string) => void;
  };

  let { spaceKey, onExit, onSelectPage, onExclude }: Props = $props();
  let directories = $state<DirectoryStats[] | null>(null);
  let total = $state(0);
  let error = $state<string | null>(null);
  let query = $state('');
  let order = $state<'pages' | 'size' | 'oldest'>('pages');

  $effect(() => {
    api.spaceMap(spaceKey).then(
      (r) => {
        directories = r.directories;
        total = r.pages;
      },
      (e: unknown) => (error = messageOf(e)),
    );
  });
  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const sorters: Record<typeof order, (a: DirectoryStats, b: DirectoryStats) => number> = {
    pages: (a, b) => b.pages - a.pages,
    size: (a, b) => b.size - a.size,
    // Directories whose newest page is oldest first: what nobody has touched in longest.
    oldest: (a, b) => (a.newest || '9').localeCompare(b.newest || '9'),
  };
  const rows = $derived(
    (directories ?? [])
      .filter((d) => [...d.path, d.title].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
      .sort(sorters[order]),
  );
  const share = (n: number): string => (total ? `${Math.round((n / total) * 100)}%` : '');
  const chars = (n: number): string =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
  const day = (iso: string): string => (iso ? iso.slice(0, 10) : '—');
</script>

<div class="review-flow" role="dialog" aria-modal="true" aria-label="Map of {spaceKey}">
  <header class="review-flow-bar">
    <button class="btn btn-secondary review-exit" onclick={onExit} title="Back to the space (Esc)">
      <ArrowLeft size={15} /> Back
    </button>
    <div class="review-flow-title">
      <strong>Map of {spaceKey}</strong>
      <span class="muted">
        {directories
          ? `${directories.length.toLocaleString('en')} directories holding ${total.toLocaleString('en')} pages`
          : 'Measuring the space…'}
      </span>
    </div>
  </header>

  <div class="page-picker-tools">
    <label class="space-map-search">
      <Search size={13} />
      <input
        class="form-input input-sm"
        placeholder="Filter directories"
        aria-label="Filter directories"
        bind:value={query}
      />
    </label>
    <Segmented
      label="Order"
      value={order}
      options={[
        { value: 'pages', label: 'Most pages' },
        { value: 'size', label: 'Most text' },
        { value: 'oldest', label: 'Untouched longest' },
      ]}
      onChange={(v) => (order = v)}
    />
  </div>

  <div class="page-picker-body">
    {#if error}
      <div class="alert alert-error">{error}</div>
    {:else if !directories}
      <p class="muted" role="status"><span class="spinner" aria-hidden="true"></span> Measuring every directory…</p>
    {:else}
      <table class="data-table space-map-table">
        <thead>
          <tr>
            <th>Directory</th>
            <th class="num">Pages below</th>
            <th class="num">Text</th>
            <th>Newest edit</th>
            <th>Notes</th>
            <th aria-label="Actions"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as d (d.id)}
            <tr>
              <td>
                {#if d.path.length}<span class="muted space-map-path">{d.path.join(' › ')} ›</span>{/if}
                <button type="button" class="link-btn" onclick={() => onSelectPage(d.id)}>{d.title}</button>
              </td>
              <td class="num">{d.pages.toLocaleString('en')} <span class="muted">{share(d.pages)}</span></td>
              <td class="num">{chars(d.size)}</td>
              <td>{day(d.newest)}</td>
              <td class="space-map-notes">
                {#if d.kind}<span class="pill" title="What the AI index's digest of this directory says it holds"
                    >{d.kind.replace('-', ' / ')}</span
                  >{/if}
                {#if d.series}<span
                    class="pill"
                    title="Pages titled like “{d.series.pattern}”, # standing for a number or date"
                    >series of {d.series.pages}</span
                  >{/if}
                {#if d.stale}<span class="pill pill-warn" title="Nothing below it has changed for a year">stale</span
                  >{/if}
                {#if d.indexed < 1}<span class="muted">{Math.round(d.indexed * 100)}% indexed</span>{/if}
              </td>
              <td>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  title="Propose a rule that keeps this directory and everything below it from any AI"
                  onclick={() => onExclude(`id:${d.id}`)}><ShieldOff size={12} /> Exclude…</button
                >
              </td>
            </tr>
          {:else}
            <tr
              ><td colspan="6" class="muted"
                >{query.trim() ? 'No directory matches.' : 'This space has no directories.'}</td
              ></tr
            >
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
