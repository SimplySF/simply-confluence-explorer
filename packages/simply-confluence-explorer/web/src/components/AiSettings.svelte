<script lang="ts">
  import { List, Save, Sparkles, Zap } from '@lucide/svelte';
  import type { AiEmbeddings, AiProvider, AiSettingsView } from '../../../src/api/types.js';
  import { api } from '../support/api.js';
  import { messageOf } from '../support/toast.svelte.js';

  // The AI provider settings. They are saved on the server, so a key typed here is sent once and never
  // shown again: the server only reports whether one is set.

  type ApiProvider = Exclude<AiProvider, 'gemini-cli'>;
  const PROVIDERS: Array<{ id: AiProvider; label: string }> = [
    { id: 'gemini-cli', label: 'Gemini CLI (installed on this machine)' },
    { id: 'anthropic', label: 'Claude (Anthropic API)' },
    { id: 'openai', label: 'ChatGPT (OpenAI API)' },
    { id: 'gemini', label: 'Gemini (Google API)' },
  ];

  let open = $state(false);
  let view = $state<AiSettingsView | null>(null);
  let provider = $state<AiProvider>('gemini-cli');
  let model = $state('');
  let baseUrl = $state('');
  let apiKey = $state('');
  let cliPath = $state('');
  let parallel = $state(2);
  let embeddings = $state<AiEmbeddings>('chat');
  let embedKey = $state('');
  let models = $state<string[]>([]);
  let message = $state('');

  const isApi = $derived(provider !== 'gemini-cli');
  const status = $derived(view && provider !== 'gemini-cli' ? view.providers[provider] : null);
  // A provider chosen for embeddings other than the chat provider needs its own key.
  const embedOwn = $derived(
    embeddings === 'openai' || embeddings === 'gemini' ? (embeddings === provider ? null : embeddings) : null,
  );
  const EMBEDDINGS: Array<{ id: AiEmbeddings; label: string }> = [
    { id: 'chat', label: 'The provider above, when it offers them' },
    { id: 'gemini', label: 'Gemini API (needs a Gemini key)' },
    { id: 'openai', label: 'OpenAI API (needs an OpenAI key)' },
    { id: 'none', label: 'Off: search by words only' },
  ];

  function load(v: AiSettingsView, chosen: AiProvider = v.provider): void {
    view = v;
    provider = chosen;
    const settings = chosen === 'gemini-cli' ? undefined : v.providers[chosen];
    model = settings?.model ?? '';
    baseUrl = settings?.baseUrl ?? '';
    cliPath = v.geminiCli.path;
    parallel = v.parallel;
    embeddings = v.embeddings;
    embedKey = '';
    apiKey = '';
    models = [];
  }

  $effect(() => {
    if (open)
      api.aiSettings().then(
        (v) => load(v),
        (e: unknown) => (message = messageOf(e)),
      );
  });

  async function save(): Promise<void> {
    message = '';
    try {
      const update: Record<string, unknown> = { provider, parallel: Number(parallel), embeddings };
      if (isApi) update[provider] = { model, baseUrl, ...(apiKey ? { apiKey } : {}) };
      if (embedOwn && embedKey) update[embedOwn] = { apiKey: embedKey };
      else update.geminiCli = { path: cliPath };
      load(await api.saveAiSettings(update), provider);
      message = 'Saved.';
    } catch (e) {
      message = messageOf(e);
    }
  }

  async function removeKey(): Promise<void> {
    try {
      load(await api.saveAiSettings({ [provider]: { apiKey: '' } }), provider);
      message = 'Key removed.';
    } catch (e) {
      message = messageOf(e);
    }
  }

  async function loadModels(): Promise<void> {
    message = 'Loading models…';
    try {
      models = await api.aiModels(provider);
      message = '';
    } catch (e) {
      message = `Could not list models: ${messageOf(e)} (save the key first)`;
    }
  }

  async function test(): Promise<void> {
    message = 'Testing…';
    try {
      const r = await api.aiTest();
      message = r.ok ? `${r.engine} answered: ${r.answer}` : `${r.engine}: ${r.error}`;
    } catch (e) {
      message = messageOf(e);
    }
  }
</script>

<details class="disclosure" ontoggle={(e) => (open = e.currentTarget.open)}>
  <summary><Sparkles size={14} /> AI provider</summary>
  {#if open && view}
    <div class="disclosure-body">
      <p class="muted field-note">
        Pages you ask about are sent to the provider chosen here. Pages excluded by <code>.confluenceignore</code> never are.
      </p>
      <div class="form-group">
        <label class="form-label" for="ai-provider">Provider</label>
        <select
          id="ai-provider"
          class="form-input"
          value={provider}
          onchange={(e) => view && load(view, e.currentTarget.value as AiProvider)}
        >
          {#each PROVIDERS as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
        </select>
      </div>

      {#if !isApi}
        <div class="form-group">
          <label class="form-label label-split" for="ai-cli">
            <span>Gemini CLI location (optional)</span>
            <span class="muted">{view.geminiCliFound ? 'found' : 'not found'}</span>
          </label>
          <input
            id="ai-cli"
            class="form-input"
            placeholder="Found automatically; or the gemini.js, gemini.cmd or install folder"
            bind:value={cliPath}
          />
          {#if view.geminiCliFound}<div class="muted field-note">Using {view.geminiCliFound}</div>{/if}
        </div>
      {/if}

      <div class="form-group">
        <label class="form-label" for="ai-parallel">Requests at once for the AI index</label>
        <input id="ai-parallel" class="form-input input-sm" type="number" min="1" max="8" bind:value={parallel} />
        <div class="muted field-note">
          How many requests indexing a space sends at a time. More finishes sooner but meets a provider's rate limits
          sooner; the Gemini CLI starts a program for each, so it does best with 2.
        </div>
      </div>

      {#if status}
        <div class="form-group">
          <label class="form-label label-split" for="ai-key">
            <span>API key</span>
            <span class="muted">
              {status.keySource === 'settings'
                ? 'set in Settings'
                : status.keySource === 'env'
                  ? 'set in the server environment'
                  : 'not set'}
            </span>
          </label>
          <div class="row">
            <input
              id="ai-key"
              type="password"
              class="form-input"
              autocomplete="off"
              placeholder={status.keySet ? 'Leave blank to keep the current key' : 'Paste your API key'}
              bind:value={apiKey}
            />
            {#if status.keySource === 'settings'}
              <button type="button" class="btn btn-secondary btn-sm" onclick={removeKey}>Remove</button>
            {/if}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="ai-model">Model</label>
          <div class="row">
            <input
              id="ai-model"
              class="form-input"
              list="ai-models"
              placeholder={view.defaults[provider as ApiProvider] || 'Choose a model'}
              bind:value={model}
            />
            <button type="button" class="btn btn-secondary btn-sm" onclick={loadModels} disabled={!status.keySet}>
              <List size={13} /> Models
            </button>
          </div>
          <datalist id="ai-models">
            {#each models as m (m)}<option value={m}></option>{/each}
          </datalist>
        </div>
        <div class="form-group">
          <label class="form-label" for="ai-endpoint">Endpoint (optional)</label>
          <input
            id="ai-endpoint"
            class="form-input"
            placeholder="Provider's public API; or your company AI gateway URL"
            bind:value={baseUrl}
          />
        </div>
      {/if}

      <div class="form-group">
        <label class="form-label" for="ai-embeddings">Search by meaning</label>
        <select id="ai-embeddings" class="form-input" bind:value={embeddings}>
          {#each EMBEDDINGS as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
        </select>
        <div class="muted field-note">
          Embeddings let a question find sections that use other words for the same thing. Claude and the Gemini CLI
          make none, so another provider can make them while answers still come from the one above. Section text is sent
          to it through the leak guard when a space is indexed.
        </div>
        {#if embedOwn}
          <input
            class="form-input"
            type="password"
            autocomplete="off"
            aria-label="{embedOwn === 'gemini' ? 'Gemini' : 'OpenAI'} API key for embeddings"
            placeholder={view.providers[embedOwn].keySet
              ? `Leave blank to keep the ${embedOwn === 'gemini' ? 'Gemini' : 'OpenAI'} key`
              : `Paste a ${embedOwn === 'gemini' ? 'Gemini' : 'OpenAI'} API key`}
            bind:value={embedKey}
          />
        {/if}
      </div>

      <div class="row">
        <button type="button" class="btn btn-primary btn-sm" onclick={save}><Save size={13} /> Save AI settings</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick={test}><Zap size={13} /> Test</button>
      </div>
      {#if message}<div class="muted field-note">{message}</div>{/if}
    </div>
  {/if}
</details>
