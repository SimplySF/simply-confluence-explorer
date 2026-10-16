<script lang="ts">
  import { Check, Copy } from '@lucide/svelte';
  import type { PageResponse } from '../../../src/api/types.js';
  import { bodyOf } from '../support/markdown.js';
  import { toast } from '../support/toast.svelte.js';
  import Markdown from './ui/Markdown.svelte';
  import Segmented from './ui/Segmented.svelte';

  // The page as it reads, as the Markdown it converts to, and as Confluence stores it.
  type View = 'rendered' | 'markdown' | 'xml';
  type Props = { page: PageResponse };

  let { page }: Props = $props();
  let view = $state<View>('rendered');
  let copied = $state(false);
  const source = $derived(view === 'xml' ? page.detail.storageXml : page.parsed.markdown);

  function copy(): void {
    navigator.clipboard.writeText(source).then(
      () => {
        copied = true;
        setTimeout(() => (copied = false), 1500);
      },
      () => toast('The browser blocked the clipboard; select the text and copy it instead.', 'error'),
    );
  }
</script>

<div class="read-panel">
  <div class="panel-bar">
    <Segmented
      label="View"
      value={view}
      onChange={(v) => (view = v)}
      options={[
        { value: 'rendered', label: 'Rendered' },
        { value: 'markdown', label: 'Markdown' },
        { value: 'xml', label: 'Storage XML', title: 'The page as Confluence stores it' },
      ]}
    />
    <button class="btn btn-secondary btn-sm" onclick={copy}>
      {#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}
      {copied ? 'Copied' : view === 'xml' ? 'Copy XML' : 'Copy Markdown'}
    </button>
  </div>
  {#if view === 'rendered'}
    <Markdown source={bodyOf(page.parsed.markdown)} />
  {:else}
    <pre class="code-viewer-box">{source}</pre>
  {/if}
</div>
