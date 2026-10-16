<script lang="ts" module>
  import type { Component } from 'svelte';

  export type MenuItem = {
    label: string;
    icon?: Component<{ size?: number }>;
    onSelect: () => void;
    disabled?: boolean;
    /** Shown under the label: what it does, or why it is unavailable. */
    hint?: string;
    danger?: boolean;
  };
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';

  // A button that opens a list of actions. Escape or a click outside closes it; arrow keys move
  // between the items.
  type Props = {
    label: Snippet;
    title?: string;
    items: Array<MenuItem | 'divider'>;
    align?: 'left' | 'right';
    buttonClass?: string;
  };

  let { label, title, items, align = 'right', buttonClass = 'btn btn-secondary btn-sm' }: Props = $props();
  let isOpen = $state(false);
  let root: HTMLDivElement;
  let button: HTMLButtonElement;

  const enabled = (): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)')];

  $effect(() => {
    if (!isOpen) return;
    const outside = (e: MouseEvent): void => {
      if (!root.contains(e.target as Node)) isOpen = false;
    };
    document.addEventListener('mousedown', outside);
    enabled()[0]?.focus();
    return () => document.removeEventListener('mousedown', outside);
  });

  function onkeydown(e: KeyboardEvent): void {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      // Stopped here so a dialog behind the menu stays open.
      e.stopPropagation();
      isOpen = false;
      button.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = enabled();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    }
  }
</script>

<div class="menu" bind:this={root} {onkeydown} role="presentation">
  <button
    bind:this={button}
    type="button"
    class={buttonClass}
    {title}
    aria-haspopup="menu"
    aria-expanded={isOpen}
    onclick={() => (isOpen = !isOpen)}
  >
    {@render label()}
  </button>
  {#if isOpen}
    <div class="menu-list menu-{align}" role="menu">
      {#each items as item, i (i)}
        {#if item === 'divider'}
          <div class="menu-divider" role="separator"></div>
        {:else}
          <button
            type="button"
            role="menuitem"
            class={['menu-item', item.danger && 'menu-danger']}
            disabled={item.disabled}
            onclick={() => {
              isOpen = false;
              item.onSelect();
            }}
          >
            <span class="menu-label">
              {#if item.icon}<item.icon size={13} />{/if}
              {item.label}
            </span>
            {#if item.hint}<span class="menu-hint">{item.hint}</span>{/if}
          </button>
        {/if}
      {/each}
    </div>
  {/if}
</div>
