<script lang="ts">
  import {
    AlertTriangle,
    CheckCircle2,
    ClipboardPaste,
    Eye,
    EyeOff,
    GitBranch,
    Info,
    Link,
    RefreshCw,
    Save,
    Settings,
    Sparkles,
    Trash2,
  } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { AuthVerifyResponse, ConnectionView } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { messageOf } from '../support/toast.svelte.js';
  import AiSettings from './AiSettings.svelte';
  import GitLabSettings from './GitLabSettings.svelte';
  import Dialog from './ui/Dialog.svelte';

  type Props = {
    onClose: () => void;
    /** Called after the connection is saved on the server. */
    onSaved: () => void;
  };

  let { onClose, onSaved }: Props = $props();
  let connection = $state<ConnectionView | null>(null);
  let baseUrl = $state('');
  // Only a new token is typed here; the saved one stays on the server and is never shown.
  let token = $state('');
  let showToken = $state(false);
  let pasteNote = $state<string | null>(null);
  let testing = $state(false);
  let testResult = $state<AuthVerifyResponse | null>(null);
  let saveError = $state<string | null>(null);
  const locked = $derived(connection?.editable === false);
  // One section at a time, chosen in the list on the left, each with a dot that says whether it is set up.
  type Section = 'confluence' | 'ai' | 'gitlab';
  let section = $state<Section>('confluence');
  let aiReady = $state(false);
  let gitlabReady = $state(false);
  let saving = $state(false);
  let aiForm = $state<{ save: () => Promise<void> }>();
  let gitlabForm = $state<{ save: () => Promise<void> }>();
  const SECTIONS: Array<{ id: Section; label: string; icon: typeof Link }> = [
    { id: 'confluence', label: 'Confluence', icon: Link },
    { id: 'ai', label: 'AI provider', icon: Sparkles },
    { id: 'gitlab', label: 'GitLab', icon: GitBranch },
  ];
  const signedIn = $derived(
    [
      testResult?.user ? `as ${testResult.user.displayName} (${testResult.user.username})` : '',
      testResult?.latencyMs !== undefined ? `· ${testResult.latencyMs} ms` : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
  const ready = (id: Section): boolean =>
    id === 'confluence' ? !!connection?.baseUrl && !!connection.tokenSet : id === 'ai' ? aiReady : gitlabReady;

  function readStatus(): void {
    api.aiStatus().then(
      (s) => (aiReady = s.available),
      () => (aiReady = false), // The dot is a hint; the section says what is wrong.
    );
    api.gitlab().then(
      (g) => (gitlabReady = !!g.baseUrl && g.tokenSet),
      () => (gitlabReady = false), // As above.
    );
  }
  $effect(() => untrack(readStatus));

  $effect(() => {
    api.connection().then(
      (view) => {
        connection = view;
        baseUrl = view.baseUrl;
        // A saved connection is tested at once, so the section opens on whether it works.
        if (view.baseUrl && view.tokenSet) void test();
      },
      (e: unknown) => (saveError = messageOf(e)),
    );
  });

  async function paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        token = text.trim();
        pasteNote = 'Pasted';
        setTimeout(() => (pasteNote = null), 1500);
      }
    } catch {
      // The browser refused clipboard access; the field still accepts Ctrl+V.
      pasteNote = 'Clipboard blocked: paste into the field with Ctrl+V';
    }
  }

  async function test(): Promise<void> {
    testing = true;
    testResult = null;
    try {
      testResult = await api.verify({ baseUrl, token: token.trim() || undefined });
    } catch (e) {
      testResult = { success: false, baseUrl, error: messageOf(e) };
    } finally {
      testing = false;
    }
  }

  async function save(): Promise<void> {
    saveError = null;
    if (section !== 'confluence') {
      saving = true;
      await (section === 'ai' ? aiForm : gitlabForm)?.save();
      saving = false;
      readStatus();
      return;
    }
    saving = true;
    try {
      await api.saveConnection({ baseUrl: baseUrl.trim(), token: token.trim() || undefined });
      onSaved();
      onClose();
    } catch (e) {
      saveError = messageOf(e);
    } finally {
      saving = false;
    }
  }
</script>

<Dialog size="dialog-settings" bodyClass="flush" {onClose}>
  {#snippet header()}<Settings size={18} /> Settings{/snippet}
  <div class="settings-layout">
    <nav class="settings-nav" aria-label="Settings sections">
      {#each SECTIONS as sec (sec.id)}
        <button
          type="button"
          class={['settings-nav-item', section === sec.id && 'active']}
          aria-current={section === sec.id ? 'page' : undefined}
          onclick={() => (section = sec.id)}
        >
          <sec.icon size={15} />
          {sec.label}
          <span
            class={['settings-dot', ready(sec.id) && 'ready']}
            title={ready(sec.id) ? 'Set up' : 'Not set up'}
            aria-label={ready(sec.id) ? 'set up' : 'not set up'}
          ></span>
        </button>
      {/each}
    </nav>
    <div class="settings-pane">
      {#if section === 'confluence'}
        {@render confluenceSection()}
      {:else if section === 'ai'}
        <h4 class="section-title first">AI provider</h4>
        <AiSettings bind:this={aiForm} onSaved={readStatus} />
      {:else}
        <h4 class="section-title first">GitLab <span class="muted">(optional)</span></h4>
        <GitLabSettings bind:this={gitlabForm} onSaved={readStatus} />
      {/if}
    </div>
  </div>

  {#snippet footer()}
    {#if saveError}<span class="field-error footer-message">{saveError}</span>{/if}
    <button class="btn btn-secondary" onclick={onClose}>Cancel</button>
    <button class="btn btn-primary" onclick={save} disabled={saving || (section === 'confluence' && locked)}
      >{#if saving}<span class="spinner" aria-hidden="true"></span>{:else}<Save size={14} />{/if} Save & apply</button
    >
  {/snippet}
</Dialog>

{#snippet confluenceSection()}
  <h4 class="section-title first">Confluence connection</h4>
  <div
    class={[
      'alert',
      'settings-banner',
      testResult ? (testResult.success ? 'alert-success' : 'alert-error') : 'alert-plain',
    ]}
  >
    {#if testing}<RefreshCw size={16} class="spin" />{:else if testResult?.success}<CheckCircle2
        size={16}
      />{:else if testResult}<AlertTriangle size={16} />{:else}<Info size={16} />{/if}
    <div class="stack-tight">
      <span>
        <strong
          >{testing
            ? 'Testing the connection…'
            : testResult
              ? testResult.success
                ? 'Connected'
                : 'Not connected'
              : 'Not tested yet'}</strong
        >
        {#if !testing && testResult?.success}{signedIn}{/if}
      </span>
      {#if testResult?.error}<span>{testResult.error}</span>{/if}
    </div>
    <button type="button" class="btn btn-secondary btn-sm" onclick={test} disabled={testing}>
      {testResult ? 'Test again' : 'Test connection'}
    </button>
  </div>
  <div class="form-group">
    <label class="form-label label-split" for="settings-url">
      <span>Confluence base URL</span>
      <span class="muted">Server or Data Center</span>
    </label>
    <input
      id="settings-url"
      type="text"
      class="form-input"
      placeholder="https://confluence.yourcompany.com"
      disabled={locked}
      bind:value={baseUrl}
    />
    {#if locked}
      <div class="muted field-note">Set by the server environment (<code>CONFLUENCE_URL</code>); change it there.</div>
    {/if}
  </div>

  <div class="form-group">
    <label class="form-label label-split" for="settings-token">
      <span>Personal access token</span>
      <span class="muted"
        >{token ? `${token.length} characters` : connection?.tokenSet ? 'saved on the server' : 'required'}</span
      >
    </label>
    <div class="row">
      <div class="secret-field">
        <input
          id="settings-token"
          type={showToken ? 'text' : 'password'}
          class="form-input"
          placeholder={connection?.tokenSet
            ? 'Leave blank to keep the saved token'
            : 'Paste your personal access token'}
          disabled={locked}
          bind:value={token}
        />
        <button
          type="button"
          class="icon-btn"
          onclick={() => (showToken = !showToken)}
          title={showToken ? 'Hide token' : 'Show token'}
          aria-label={showToken ? 'Hide token' : 'Show token'}
        >
          {#if showToken}<EyeOff size={16} />{:else}<Eye size={16} />{/if}
        </button>
      </div>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        onclick={paste}
        title="Paste the token from the clipboard"
        disabled={locked}
      >
        <ClipboardPaste size={15} /> Paste
      </button>
      {#if token}
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          onclick={() => (token = '')}
          title="Clear"
          aria-label="Clear token"
        >
          <Trash2 size={15} />
        </button>
      {/if}
    </div>
    {#if pasteNote}<div class="muted field-note">{pasteNote}</div>{/if}
  </div>

  <details class="disclosure">
    <summary><Info size={14} /> How to create a personal access token in Confluence</summary>
    <ol class="plain-list disclosure-body">
      <li>Open your Confluence Server or Data Center in your browser.</li>
      <li>
        Click your <strong>profile picture</strong> in the top-right corner and choose
        <strong>Personal Access Tokens</strong>.
      </li>
      <li>
        Click <strong>Create token</strong>, give it a name (for example <code>confluence-explorer</code>), set an
        expiry, and click <strong>Create</strong>.
      </li>
      <li>Copy the token and paste it above with <strong>Paste</strong>.</li>
    </ol>
  </details>

  <p class="muted field-note form-group">
    Certificates are always checked. If your Confluence uses your company's own certificate authority, start the app
    with
    <code>NODE_EXTRA_CA_CERTS</code> set to that authority's certificate file.
  </p>
{/snippet}
