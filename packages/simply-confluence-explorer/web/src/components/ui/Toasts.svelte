<script lang="ts">
  import { AlertTriangle, CheckCircle2, Info, X } from '@lucide/svelte';
  import { observe } from '../../support/observe.svelte.js';
  import { dismiss, toasts, type Toast, type ToastAction } from '../../support/toast.svelte.js';

  const ICON = { info: Info, success: CheckCircle2, error: AlertTriangle };

  // Every error leads somewhere: to its own trace when it has one, otherwise to the recent warnings
  // and errors on the Observability page (design doc 0008).
  const actionOf = (t: Toast): ToastAction | undefined =>
    t.action ??
    (t.kind === 'error'
      ? { label: 'See logs', run: () => observe.show('logs', { filter: { levels: ['error', 'warn'], range: '15m' } }) }
      : undefined);
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each toasts as t (t.id)}
    {@const Icon = ICON[t.kind]}
    {@const action = actionOf(t)}
    <div class="toast toast-{t.kind}">
      <Icon size={15} />
      <span>{t.message}</span>
      {#if action}
        <button
          type="button"
          class="toast-action"
          onclick={() => {
            action.run();
            dismiss(t.id);
          }}>{action.label}</button
        >
      {/if}
      <button type="button" onclick={() => dismiss(t.id)} aria-label="Dismiss"><X size={13} /></button>
    </div>
  {/each}
</div>
