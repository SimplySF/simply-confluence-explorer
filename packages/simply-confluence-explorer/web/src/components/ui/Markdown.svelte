<script lang="ts">
  import { renderMarkdown } from '../../support/markdown.js';

  // Rendered Markdown. renderMarkdown escapes raw HTML, which is what makes {@html} safe here.
  type Props = { source: string; extraClass?: string };

  let { source, extraClass = 'markdown-preview' }: Props = $props();
</script>

<div class={extraClass}>{@html renderMarkdown(source)}</div>
