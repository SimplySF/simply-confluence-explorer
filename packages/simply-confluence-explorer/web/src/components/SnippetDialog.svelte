<script lang="ts">
  import { Check, Copy, FileCode } from '@lucide/svelte';
  import { api } from '../support/api.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import Dialog from './ui/Dialog.svelte';
  import Markdown from './ui/Markdown.svelte';

  type Props = { onClose: () => void };

  let { onClose }: Props = $props();
  let input = $state(`<ac:structured-macro ac:name="code">
  <ac:parameter ac:name="language">python</ac:parameter>
  <ac:plain-text-body><![CDATA[def parse_confluence():
    print("Converting storage format XHTML to clean markdown")]]></ac:plain-text-body>
</ac:structured-macro>

<ac:structured-macro ac:name="info">
  <ac:parameter ac:name="title">Note</ac:parameter>
  <ac:rich-text-body><p>Works offline with full macro support.</p></ac:rich-text-body>
</ac:structured-macro>`);
  let markdown = $state('');
  let copied = $state(false);
  let parsing = $state(false);

  async function convert(): Promise<void> {
    parsing = true;
    try {
      markdown = (await api.parse(input)).markdown;
    } catch (e) {
      toast(`Not converted: ${messageOf(e)}`, 'error');
    } finally {
      parsing = false;
    }
  }

  function copy(): void {
    navigator.clipboard.writeText(markdown).then(
      () => {
        copied = true;
        setTimeout(() => (copied = false), 2000);
      },
      () => toast('The browser blocked the clipboard; select the Markdown and copy it instead.', 'error'),
    );
  }
</script>

<Dialog size="dialog-wide" {onClose} closeOnBackdrop>
  {#snippet header()}<FileCode size={18} /> Snippet parser{/snippet}
  <div class="stack">
    <label class="form-label" for="snippet-input">Confluence storage XML</label>
    <textarea
      id="snippet-input"
      class="code-viewer-box snippet-input"
      bind:value={input}
      placeholder="Paste <ac:structured-macro> or <p>...</p> here..."
    ></textarea>
    <div class="row">
      <button class="btn btn-primary btn-sm" onclick={convert} disabled={parsing}>
        {parsing ? 'Converting…' : 'Convert to Markdown'}
      </button>
      {#if markdown}
        <button class="btn btn-secondary btn-sm" onclick={copy}>
          {#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}
          {copied ? 'Copied' : 'Copy Markdown'}
        </button>
      {/if}
    </div>
    {#if markdown}
      <div class="two-col snippet-output">
        <div class="stack">
          <span class="list-heading">Markdown</span>
          <pre class="code-viewer-box">{markdown}</pre>
        </div>
        <div class="stack">
          <span class="list-heading">Rendered</span>
          <Markdown source={markdown} extraClass="markdown-preview snippet-preview" />
        </div>
      </div>
    {/if}
  </div>
  {#snippet footer()}<button class="btn btn-secondary" onclick={onClose}>Close</button>{/snippet}
</Dialog>
