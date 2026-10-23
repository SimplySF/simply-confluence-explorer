<script lang="ts">
  import { ChevronDown, Download, ExternalLink, FolderTree, RefreshCw, Sparkles } from '@lucide/svelte';
  import type { PageMetadata, PageResponse } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { jobs } from '../support/jobs.svelte.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import JobProgress from './ui/JobProgress.svelte';
  import Menu from './ui/Menu.svelte';

  // The page's entry in the AI index (its summary, topics and questions), its frontmatter, and its attachments.
  type Props = {
    page: PageResponse;
    spaceKey: string;
    descendantCount: number;
    metadata: PageMetadata | null;
    metadataLoading: boolean;
    /** A summary arrived for a page, which may no longer be the one on screen. */
    onMetadata: (pageId: string, m: PageMetadata | null) => void;
    onMetadataLoading: (pageId: string, loading: boolean) => void;
    reloadMetadata: () => void;
  };

  let {
    page,
    spaceKey,
    descendantCount,
    metadata,
    metadataLoading,
    onMetadata,
    onMetadataLoading,
    reloadMetadata,
  }: Props = $props();
  const detail = $derived(page.detail);
  // The run lives in the jobs store, so it is still shown after the person opens another page and comes back.
  const job = $derived(jobs.summaries(spaceKey, detail.id));
  $effect(() => jobs.onFinished((j) => j.kind === 'summaries' && j.spaceKey === spaceKey && reloadMetadata()));

  async function generateOne(): Promise<void> {
    const pageId = detail.id;
    onMetadataLoading(pageId, true);
    try {
      onMetadata(pageId, await api.generatePageMetadata(spaceKey, pageId));
    } catch (e) {
      toast(`The page was not indexed: ${messageOf(e)}`, 'error');
    } finally {
      onMetadataLoading(pageId, false);
    }
  }

  const generateLabel = $derived(metadataLoading ? 'Indexing…' : metadata ? 'Re-index' : 'Index this page');
</script>

<div class="details-panel">
  <section class="card">
    <div class="card-head">
      <h4><Sparkles size={15} /> AI index</h4>
      {#if job}
        <JobProgress processed={job.processed} total={job.total} current={job.current} onStop={() => jobs.stop(job!)} />
      {:else if descendantCount > 0}
        <Menu
          items={[
            { label: 'This page only', onSelect: generateOne, disabled: metadataLoading },
            {
              label: `This page and its ${descendantCount} sub-pages`,
              icon: FolderTree,
              onSelect: () => jobs.startSummaries(spaceKey, detail.id),
              disabled: metadataLoading,
            },
          ]}
        >
          {#snippet label()}
            <RefreshCw size={12} class={metadataLoading ? 'spin' : ''} />
            {generateLabel}
            <ChevronDown size={12} />
          {/snippet}
        </Menu>
      {:else}
        <button class="btn btn-secondary btn-sm" onclick={generateOne} disabled={metadataLoading}>
          <RefreshCw size={12} class={metadataLoading ? 'spin' : ''} />
          {generateLabel}
        </button>
      {/if}
    </div>
    {#if metadata}
      <p class="details-summary">{metadata.summary}</p>
      <div class="chip-row">
        {#if metadata.documentType}<span class="pill pill-plain">{metadata.documentType}</span>{/if}
        {#each metadata.tags as t (t)}<span class="pill">#{t}</span>{/each}
        {#each metadata.systemsMentioned as s (s)}<span class="pill pill-plain">{s}</span>{/each}
      </div>
      {#if metadata.audience}<p class="muted">Written for {metadata.audience}.</p>{/if}
      {#if metadata.questions?.length}
        <details class="details-questions">
          <summary>Questions it answers ({metadata.questions.length})</summary>
          <ul>
            {#each metadata.questions as q (q)}<li>{q}</li>{/each}
          </ul>
        </details>
      {/if}
    {:else}
      <p class="muted">
        {metadataLoading
          ? 'Loading…'
          : 'Not indexed yet. Indexing gives the page a summary, topics and the questions it answers, which chats use to find it.'}
      </p>
    {/if}
  </section>

  <h4 class="section-title">Frontmatter</h4>
  <pre class="code-viewer-box">{JSON.stringify(page.parsed.frontmatter, null, 2)}</pre>

  <h4 class="section-title">Attachments ({detail.attachments.length})</h4>
  {#if detail.attachments.length === 0}
    <p class="muted">No attachments.</p>
  {:else}
    <table class="data-table">
      <thead><tr><th>File</th><th>Type</th><th>Size</th><th></th></tr></thead>
      <tbody>
        {#each detail.attachments as a, i (a.id)}
          <tr>
            <td>{a.title}</td>
            <td class="muted">{a.mediaType}</td>
            <td class="muted">{(a.fileSize / 1024).toFixed(1)} KB</td>
            <td class="attachment-actions">
              {#if page.onDisk?.[i]}
                <a
                  href={`/api/space-cache/${encodeURIComponent(spaceKey)}/pages/${encodeURIComponent(detail.id)}/attachments/${i}`}
                  class="btn btn-secondary btn-sm"
                  download={a.title}
                >
                  <Download size={12} /> Download
                </a>
              {:else if page.isLocal}
                <span class="muted">Not on this machine, sync the space again</span>
              {/if}
              <a href={a.downloadUrl} class="btn btn-secondary btn-sm" target="_blank" rel="noreferrer">
                <ExternalLink size={12} /> Open in Confluence
              </a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
