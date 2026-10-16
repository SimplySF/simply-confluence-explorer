<script lang="ts" module>
  // Dialogs can stack (a confirmation over a workspace); Escape closes only the top one.
  const open: number[] = [];
  let nextId = 0;
</script>

<script lang="ts">
  import { X } from '@lucide/svelte';
  import { onMount, type Snippet } from 'svelte';

  type Props = {
    header: Snippet;
    onClose: () => void;
    children: Snippet;
    footer?: Snippet;
    /** Sizes the panel: `dialog-wide`, `dialog-narrow`, or a dialog's own class. */
    size?: string;
    bodyClass?: string;
    /** A click outside closes it; off where closing would lose typed work. */
    closeOnBackdrop?: boolean;
  };

  let { header, onClose, children, footer, size = '', bodyClass = '', closeOnBackdrop = false }: Props = $props();
  const id = ++nextId;
  let panel: HTMLDivElement;

  onMount(() => {
    open.push(id);
    const before = document.activeElement as HTMLElement | null;
    // An autofocused field inside keeps its focus; otherwise the panel takes it, so Tab starts inside.
    if (!panel.contains(document.activeElement)) panel.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && open.at(-1) === id) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      open.splice(open.indexOf(id), 1);
      before?.focus?.();
    };
  });
</script>

<div
  class="modal-overlay"
  role="presentation"
  onmousedown={(e) => closeOnBackdrop && e.target === e.currentTarget && onClose()}
>
  <div
    class="modal-dialog {size}"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dialog-{id}-title"
    tabindex="-1"
    bind:this={panel}
  >
    <div class="modal-header">
      <h3 class="modal-title" id="dialog-{id}-title">{@render header()}</h3>
      <button class="btn btn-secondary btn-sm" onclick={onClose} aria-label="Close" title="Close (Esc)">
        <X size={14} />
      </button>
    </div>
    <div class="modal-body {bodyClass}">{@render children()}</div>
    {#if footer}<div class="modal-footer">{@render footer()}</div>{/if}
  </div>
</div>
