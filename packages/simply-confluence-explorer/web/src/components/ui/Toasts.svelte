<script lang="ts">
  import { AlertTriangle, CheckCircle2, Info, X } from '@lucide/svelte';
  import { dismiss, toasts } from '../../support/toast.svelte.js';

  const ICON = { info: Info, success: CheckCircle2, error: AlertTriangle };
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each toasts as t (t.id)}
    {@const Icon = ICON[t.kind]}
    <div class="toast toast-{t.kind}">
      <Icon size={15} />
      <span>{t.message}</span>
      <button type="button" onclick={() => dismiss(t.id)} aria-label="Dismiss"><X size={13} /></button>
    </div>
  {/each}
</div>
