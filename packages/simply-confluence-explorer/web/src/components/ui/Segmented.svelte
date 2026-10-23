<script lang="ts" generics="T extends string">
  // One choice out of a few, shown side by side.
  type Option = { value: T; label: string; title?: string; disabled?: boolean };
  type Props = {
    value: T;
    options: Option[];
    label: string;
    onChange: (value: T) => void;
    /** Without a frame, for a choice that sits in a toolbar. */
    quiet?: boolean;
  };

  let { value, options, label, onChange, quiet = false }: Props = $props();
</script>

<div class={['segmented', quiet && 'segmented-quiet']} role="group" aria-label={label}>
  {#each options as o (o.value)}
    <button
      type="button"
      class={{ active: o.value === value }}
      aria-pressed={o.value === value}
      title={o.title}
      disabled={o.disabled}
      onclick={() => onChange(o.value)}
    >
      {o.label}
    </button>
  {/each}
</div>
