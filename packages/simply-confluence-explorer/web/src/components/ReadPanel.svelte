<script lang="ts" module>
  export type ReadView = 'rendered' | 'markdown' | 'xml';
</script>

<script lang="ts">
  import type { PageResponse } from '../../../src/api/types.js';
  import { bodyOf } from '../support/markdown.js';
  import Markdown from './ui/Markdown.svelte';

  // The page as it reads, as the Markdown it converts to, and as Confluence stores it. The choice sits
  // in the page's tab bar.
  type Props = { page: PageResponse; view: ReadView };

  let { page, view }: Props = $props();
</script>

<div class="read-panel">
  {#if view === 'rendered'}
    <Markdown source={bodyOf(page.parsed.markdown)} extraClass="markdown-preview read-article" />
  {:else}
    <pre class="code-viewer-box">{view === 'xml' ? page.detail.storageXml : page.parsed.markdown}</pre>
  {/if}
</div>
