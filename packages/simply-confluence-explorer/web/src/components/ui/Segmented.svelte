<script lang="ts" generics="T extends string">
  // One choice out of a few, shown side by side.
  type Option = { value: T; label: string; title?: string; disabled?: boolean };
  type Props = { value: T; options: Option[]; label: string; onChange: (value: T) => void };

  let { value, options, label, onChange }: Props = $props();
</script>

<div class="segmented" role="group" aria-label={label}>
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
