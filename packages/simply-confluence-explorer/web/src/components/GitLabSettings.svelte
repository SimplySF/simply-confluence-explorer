<script lang="ts">
  import { Zap } from '@lucide/svelte';
  import type { GitLabView } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { messageOf } from '../support/toast.svelte.js';

  // The GitLab connection, used to read a repository when writing new pages (ADR-050), a section of
  // Settings, which saves it with its Save & apply. The token is saved on the server and never shown
  // again: the server only says whether one is set.
  type Props = { onSaved?: () => void };

  let { onSaved }: Props = $props();
  let view = $state<GitLabView | null>(null);
  let baseUrl = $state('');
  let token = $state('');
  let message = $state('');

  $effect(() => {
    if (view) return;
    api.gitlab().then(
      (v) => {
        view = v;
        baseUrl = v.baseUrl;
      },
      (e: unknown) => (message = messageOf(e)),
    );
  });

  export async function save(): Promise<void> {
    try {
      view = await api.saveGitlab({ baseUrl, ...(token ? { token } : {}) });
      token = '';
      message = 'Saved.';
      onSaved?.();
    } catch (e) {
      message = messageOf(e);
    }
  }

  async function test(): Promise<void> {
    message = 'Testing…';
    try {
      const r = await api.testGitlab({ baseUrl, ...(token ? { token } : {}) });
      message =
        r.ok && r.user ? `Signed in to GitLab as ${r.user.name} (${r.user.username}).` : (r.error ?? 'Not connected.');
    } catch (e) {
      message = messageOf(e);
    }
  }
</script>

{#if view}
  <div class="settings-section">
    <p class="muted field-note">
      With a GitLab connection, a new page can be written from a repository's README, docs and API files. Only
      repositories on this GitLab are read. A token with <code>read_api</code> or <code>read_repository</code> is enough.
    </p>
    <div class="form-group">
      <label class="form-label" for="gitlab-url">GitLab address</label>
      <input id="gitlab-url" class="form-input" placeholder="https://gitlab.yourcompany.com" bind:value={baseUrl} />
    </div>
    <div class="form-group">
      <label class="form-label label-split" for="gitlab-token">
        <span>Personal access token</span>
        <span class="muted"
          >{token ? `${token.length} characters` : view.tokenSet ? 'saved on the server' : 'not set'}</span
        >
      </label>
      <input
        id="gitlab-token"
        type="password"
        class="form-input"
        placeholder={view.tokenSet ? 'Leave blank to keep the saved token' : 'Paste a GitLab token'}
        bind:value={token}
      />
    </div>
    <div class="row">
      <button type="button" class="btn btn-secondary btn-sm" onclick={test}><Zap size={13} /> Test</button>
    </div>
    {#if message}<div class="muted field-note">{message}</div>{/if}
  </div>
{:else if message}
  <div class="field-error">{message}</div>
{:else}
  <p class="muted">Loading the GitLab settings…</p>
{/if}
