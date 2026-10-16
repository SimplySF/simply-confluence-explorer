<script lang="ts">
  import { lineDiff } from '../../support/lineDiff.js';

  // A proposed change against the current text, one line per row. A newline at the very end says
  // nothing about the page, so it is not shown as a change.
  type Props = { before: string; after: string; extraClass?: string };

  let { before, after, extraClass = '' }: Props = $props();
  const lines = $derived(lineDiff(before.trimEnd(), after.trimEnd()));
  const MARK = { added: '+ ', removed: '- ', same: '  ' };
</script>

<pre class="branch-diff {extraClass}">{#each lines as d, n (n)}<div class="diff-{d.kind}">{MARK[
        d.kind
      ]}{d.text}</div>{/each}</pre>
