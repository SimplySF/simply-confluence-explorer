<script lang="ts">
  import { renderMarkdown, type Pictures } from '../../support/markdown.js';

  // Rendered Markdown. renderMarkdown escapes raw HTML, which is what makes {@html} safe here.
  type Props = { source: string; extraClass?: string; pictures?: Pictures };

  let { source, extraClass = 'markdown-preview', pictures }: Props = $props();
</script>

<div class={extraClass}>{@html renderMarkdown(source, pictures)}</div>
