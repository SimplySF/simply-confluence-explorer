<script lang="ts">
  import { RefreshCw, Save, ShieldCheck } from '@lucide/svelte';
  import type { ImageChoice } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { imageChoices } from '../support/imageChoice.svelte.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import Dialog from './ui/Dialog.svelte';
  import Segmented from './ui/Segmented.svelte';

  // A space's two lines of defence before anything reaches an AI: pages that are never sent
  // (.confluenceignore), and what is blocked or replaced in anything that is (.confluenceguard).
  type Props = { spaceKey: string; onClose: () => void; onSaved: () => void };

  let { spaceKey, onClose, onSaved }: Props = $props();
  // null until loaded: typing before the saved rules arrive would be overwritten by them.
  let ignore = $state<string | null>(null);
  let guard = $state<string | null>(null);
  // Removing what the rules now exclude is the default, because the synced copy is what a ZIP holds.
  let removeExcluded = $state(true);
  let busy = $state<'ignore' | 'guard' | null>(null);
  let images = $state<ImageChoice | null>(null);
  let loadError = $state<string | null>(null);

  $effect(() => {
    api.ignore(spaceKey).then(
      (p) => (ignore = p.join('\n')),
      (e: unknown) => (loadError = messageOf(e)),
    );
    api.guard(spaceKey).then(
      (t) => (guard = t),
      (e: unknown) => (loadError = messageOf(e)),
    );
    api.spaceSettings(spaceKey).then(
      (s) => (images = s.images),
      (e: unknown) => (loadError = messageOf(e)),
    );
  });

  async function chooseImages(next: ImageChoice): Promise<void> {
    try {
      images = (await api.saveSpaceSettings(spaceKey, next)).images;
      imageChoices[spaceKey] = images;
    } catch (e) {
      toast(messageOf(e), 'error');
    }
  }

  async function saveIgnore(): Promise<void> {
    busy = 'ignore';
    try {
      const patterns = (ignore ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      const res = await api.saveIgnore(spaceKey, patterns, removeExcluded);
      const removed = res.purged?.purgedCount
        ? ` Removed ${res.purged.purgedCount} synced page(s) they now exclude.`
        : '';
      toast(`Exclusions saved for ${spaceKey}.${removed}`, 'success');
      onSaved();
    } catch (e) {
      toast(`Exclusions not saved: ${messageOf(e)}`, 'error');
    } finally {
      busy = null;
    }
  }

  async function saveGuard(): Promise<void> {
    busy = 'guard';
    try {
      guard = await api.saveGuard(spaceKey, guard ?? '');
      toast(`Leak guard rules saved for ${spaceKey}.`, 'success');
    } catch (e) {
      toast(`Guard rules not saved: ${messageOf(e)}`, 'error');
    } finally {
      busy = null;
    }
  }
</script>

<Dialog size="dialog-wide" {onClose}>
  {#snippet header()}<ShieldCheck size={16} /> {spaceKey}: exclusions and leak guard{/snippet}
  {#if loadError}<div class="alert alert-error">{loadError}</div>{/if}
  <section class="rules-section">
    <h4>Never send these pages to an AI</h4>
    <p class="muted">
      One pattern per line: a folder (<code>Security/</code>), a title (<code>*Confidential*</code>) or a page id (<code
        >id:12345</code
      >). Matching pages, and everything under them, are left out of AI questions, proposals, summaries and search.
    </p>
    <textarea
      class="form-input code-editor"
      rows="6"
      placeholder={ignore === null ? 'Loading…' : '# no exclusions: every page may be sent'}
      disabled={ignore === null}
      value={ignore ?? ''}
      oninput={(e) => (ignore = e.currentTarget.value)}
    ></textarea>
    <label class="checkbox-group">
      <input type="checkbox" bind:checked={removeExcluded} />
      <span>Also delete the synced copies of pages these rules exclude from this machine</span>
    </label>
    <button class="btn btn-primary btn-sm" onclick={saveIgnore} disabled={!!busy || ignore === null}>
      {#if busy === 'ignore'}<RefreshCw size={12} class="spin" />{:else}<Save size={12} />{/if} Save exclusions
    </button>
  </section>
  <section class="rules-section">
    <h4>Leak guard rules</h4>
    <p class="muted">
      Before anything is sent to an AI, secrets stop the request and personal data is replaced with placeholders. Add
      your own, one per line: <code>block: PROJECT-[A-Z]+ as codename</code>,
      <code>redact: EMP\d&#123;6&#125; as employee-id</code>, or <code>allow: .+@example\.com</code> for values that are safe.
    </p>
    <textarea
      class="form-input code-editor"
      rows="5"
      placeholder={guard === null ? 'Loading…' : '# no custom rules: the built-in ones apply'}
      disabled={guard === null}
      value={guard ?? ''}
      oninput={(e) => (guard = e.currentTarget.value)}
    ></textarea>
    <button class="btn btn-primary btn-sm" onclick={saveGuard} disabled={!!busy || guard === null}>
      {#if busy === 'guard'}<RefreshCw size={12} class="spin" />{:else}<Save size={12} />{/if} Save guard rules
    </button>
  </section>
  <section class="rules-section">
    <h4>Images on pages</h4>
    <p class="muted">
      Text attachments are read with their page and checked by the leak guard. Images cannot be checked, so they are
      only sent if you choose: <strong>Ask</strong> asks wherever pages with images are read.
    </p>
    {#if images}
      <Segmented
        label="Images"
        value={images}
        onChange={(v) => void chooseImages(v)}
        options={[
          { value: 'ask', label: 'Ask' },
          { value: 'send', label: 'Send images' },
          { value: 'skip', label: 'Do not send' },
        ]}
      />
    {/if}
  </section>
</Dialog>
