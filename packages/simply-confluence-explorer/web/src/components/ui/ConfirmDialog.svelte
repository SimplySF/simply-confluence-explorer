<script lang="ts">
  import type { Snippet } from 'svelte';
  import Dialog from './Dialog.svelte';

  // A question that needs an answer before something is written or deleted.
  type Props = {
    title: string;
    children: Snippet;
    confirmLabel: Snippet;
    onConfirm: () => void;
    onCancel: () => void;
    danger?: boolean;
    busy?: boolean;
  };

  let { title, children, confirmLabel, onConfirm, onCancel, danger = false, busy = false }: Props = $props();
</script>

<Dialog onClose={onCancel} size="dialog-narrow">
  {#snippet header()}{title}{/snippet}
  {@render children()}
  {#snippet footer()}
    <button class="btn btn-secondary" onclick={onCancel} disabled={busy}>Cancel</button>
    <button class={['btn', danger ? 'btn-danger' : 'btn-primary']} onclick={onConfirm} disabled={busy}>
      {@render confirmLabel()}
    </button>
  {/snippet}
</Dialog>
