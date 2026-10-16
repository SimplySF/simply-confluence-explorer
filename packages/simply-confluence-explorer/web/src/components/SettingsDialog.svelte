<script lang="ts">
  import {
    AlertTriangle,
    CheckCircle2,
    ClipboardPaste,
    Eye,
    EyeOff,
    Info,
    RefreshCw,
    Save,
    Settings,
    Trash2,
  } from '@lucide/svelte';
  import type { AuthVerifyResponse, ConnectionView } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { messageOf } from '../support/toast.svelte.js';
  import AiSettings from './AiSettings.svelte';
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

  $effect(() => {
    api.connection().then(
      (view) => {
        connection = view;
        baseUrl = view.baseUrl;
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
    try {
      await api.saveConnection({ baseUrl: baseUrl.trim(), token: token.trim() || undefined });
      onSaved();
      onClose();
    } catch (e) {
      saveError = messageOf(e);
    }
  }
</script>

<Dialog size="dialog-settings" {onClose}>
  {#snippet header()}<Settings size={18} /> Settings{/snippet}
  <h4 class="section-title first">Confluence connection</h4>
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

  <button type="button" class="btn btn-secondary btn-sm" onclick={test} disabled={testing}>
    {#if testing}<RefreshCw size={14} class="spin" />{/if}
    {testing ? 'Testing…' : 'Test connection'}
  </button>

  {#if testResult}
    <div class={['alert', testResult.success ? 'alert-success' : 'alert-error']}>
      {#if testResult.success}<CheckCircle2 size={16} />{:else}<AlertTriangle size={16} />{/if}
      <div class="stack-tight">
        <strong>
          {testResult.success ? 'Connected' : 'Not connected'}
          {#if testResult.latencyMs !== undefined}<span class="muted"> ({testResult.latencyMs} ms)</span>{/if}
        </strong>
        {#if testResult.success && testResult.user}
          <span>Signed in as <strong>{testResult.user.displayName}</strong> ({testResult.user.username})</span>
        {/if}
        {#if testResult.error}<span>{testResult.error}</span>{/if}
      </div>
    </div>
  {/if}

  <AiSettings />

  {#snippet footer()}
    {#if saveError}<span class="field-error footer-message">{saveError}</span>{/if}
    <button class="btn btn-secondary" onclick={onClose}>Cancel</button>
    <button class="btn btn-primary" onclick={save} disabled={locked}><Save size={14} /> Save & Apply</button>
  {/snippet}
</Dialog>
