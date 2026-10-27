<script lang="ts">
  import { FileText, Folder, Globe, ListTree, Tag, X } from '@lucide/svelte';
  import type { PageTreeNode, SessionScope, TaggedPages } from '../../../src/api/types.js';
  import { api, type Coverage } from '../support/api.js';
  import type { AiChat } from '../support/chat.svelte.js';
  import type { Choice as Picked } from '../support/choice.js';
  import { readTags } from '../support/pageResult.js';
  import { directoryLabel, readingLine, type SpacePage } from '../support/pages.js';
  import PagePicker from './PagePicker.svelte';
  import SummaryCoverage from './SummaryCoverage.svelte';

  // What a Space chat reads, as one row above it: a chip for each directory (with every page under it,
  // less any left out), page, tag and title rule the person chose, or the whole space when nothing is
  // chosen (ADR-051, design doc 0016). The count says how many are indexed, and its hint whether each
  // question reads them all or finds the sections it needs in them. Choose pages opens the picker.
  type Choice = { kind: 'space' } | ({ kind: 'pages' } & Picked);
  type Props = {
    spaceKey: string;
    scope: SessionScope;
    /** The space's pages, to name chips by; excluded pages are never among them. */
    pages: SpacePage[];
    /** The space's tree, to choose from. */
    tree: PageTreeNode[];
    /** Saves a new choice; the row shows it at once, marked as saving, until this settles. */
    onChange: (choice: Choice) => Promise<void>;
    onSelectPage: (pageId: string) => void;
    /** The chat, which keeps its choice about its pages' attachments. */
    chat?: AiChat;
    /** What the chosen pages hold, shared with the chat's notes on their attachments. */
    counts?: Coverage | null;
    /** The chosen pages are being checked, so the chat waits and says so. */
    checking?: boolean;
  };

  let {
    spaceKey,
    scope,
    pages,
    tree,
    onChange,
    onSelectPage,
    chat,
    counts = $bindable(null),
    checking = $bindable(false),
  }: Props = $props();
  let picking = $state(false);
  let tags = $state<TaggedPages[] | null>(null);

  // A choice being saved is shown at once; the saved scope takes over when the save settles, and a
  // failed save leaves the row as it was.
  // Raw, so the choice compared when its save settles is the one that was made, not a proxy of it.
  let saving = $state.raw<Choice | null>(null);
  const shown = $derived<Choice | SessionScope>(saving ?? scope);
  const picked = $derived<Picked>({
    dirs: shown.kind === 'pages' ? (shown.dirs ?? []) : [],
    pageIds: shown.kind === 'pages' ? (shown.pageIds ?? []) : [],
    tags: shown.kind === 'pages' ? (shown.tags ?? []) : [],
    leftOut: shown.kind === 'pages' ? (shown.leftOut ?? []) : [],
    leaveOutTitles: shown.kind === 'pages' ? (shown.leaveOutTitles ?? []) : [],
  });
  $effect(() => {
    if (!picked.tags.length || tags) return;
    return readTags(
      () => api.tags(spaceKey),
      (t) => (tags = t),
      () => undefined,
      () => (tags = []),
    );
  });
  const byId = $derived(new Map(pages.map((p) => [p.id, p])));
  const pageOf = (id: string): SpacePage => byId.get(id) ?? { id, title: id, path: '', under: [] };
  const tagSize = (tag: string): number | undefined => tags?.find((t) => t.tag === tag)?.pages.length;
  // How many pages under a directory are left out by a tick, each with everything under it.
  const leftUnder = (dir: string): number => {
    const under = new Set(pageOf(dir).under);
    return picked.leftOut.filter((id) => under.has(id)).reduce((n, id) => n + 1 + pageOf(id).under.length, 0);
  };
  const chosen = $derived(scope.kind === 'pages' ? picked : undefined);

  function choose(next: Partial<Picked>): void {
    const all = { ...picked, ...next };
    const made: Choice =
      all.dirs.length + all.pageIds.length + all.tags.length === 0 ? { kind: 'space' } : { kind: 'pages', ...all };
    saving = made;
    void onChange(made).finally(() => {
      if (saving === made) saving = null;
    });
  }
  // A directory removed takes the pages left out of it with it.
  const removeDir = (id: string): void => {
    const under = new Set(pageOf(id).under);
    choose({ dirs: picked.dirs.filter((d) => d !== id), leftOut: picked.leftOut.filter((l) => !under.has(l)) });
  };
</script>

<div class="scope-bar chat-context">
  <span>Reading</span>
  {#each picked.dirs as id (id)}
    <span class="scope-chip">
      <Folder size={12} />
      <button type="button" class="scope-chip-name" onclick={() => onSelectPage(id)} title="Open {pageOf(id).title}"
        >{directoryLabel(pageOf(id))}{leftUnder(id) ? `, ${leftUnder(id)} left out` : ''}</button
      >
      <button
        type="button"
        class="scope-chip-remove"
        aria-label="Remove {pageOf(id).title} and its sub-pages"
        onclick={() => removeDir(id)}><X size={12} /></button
      >
    </span>
  {/each}
  {#each picked.pageIds as id (id)}
    <span class="scope-chip">
      <FileText size={12} />
      <button type="button" class="scope-chip-name" onclick={() => onSelectPage(id)} title="Open {pageOf(id).title}"
        >{pageOf(id).title}</button
      >
      <button
        type="button"
        class="scope-chip-remove"
        aria-label="Remove {pageOf(id).title}"
        onclick={() => choose({ pageIds: picked.pageIds.filter((p) => p !== id) })}><X size={12} /></button
      >
    </span>
  {/each}
  {#each picked.tags as t (t)}
    <span class="scope-chip">
      <Tag size={12} />
      <span class="scope-chip-name">#{t}{tagSize(t) === undefined ? '' : ` · ${tagSize(t)}`}</span>
      <button
        type="button"
        class="scope-chip-remove"
        aria-label="Remove #{t}"
        onclick={() => choose({ tags: picked.tags.filter((x) => x !== t) })}><X size={12} /></button
      >
    </span>
  {/each}
  {#each picked.leaveOutTitles as r (r)}
    <span class="scope-chip" title="Every chosen page whose title holds these words is left out, now and later">
      <span class="scope-chip-name">Not: titles with “{r}”</span>
      <button
        type="button"
        class="scope-chip-remove"
        aria-label="Stop leaving out titles with {r}"
        onclick={() => choose({ leaveOutTitles: picked.leaveOutTitles.filter((x) => x !== r) })}><X size={12} /></button
      >
    </span>
  {/each}
  {#if saving}
    <span class="scope-saving" role="status"><span class="spinner" aria-hidden="true"></span> Saving…</span>
  {/if}
  {#if shown.kind !== 'pages'}
    <span class="scope-chip scope-chip-plain" title="Each question searches the whole space for the sections it needs">
      <Globe size={12} /> Whole space{pages.length ? ` · ${pages.length} pages` : ''}
    </span>
  {/if}
  <button
    type="button"
    class="scope-chip scope-chip-add"
    onclick={() => (picking = true)}
    title="Tick the directories, pages and tags to read, and leave out what does not belong; with none, the chat reads the whole space"
  >
    <ListTree size={12} /> Choose pages…
  </button>
  <span class="spacer"></span>
  <span title={counts ? readingLine(counts) : undefined}>
    <SummaryCoverage {spaceKey} {chosen} bind:counts bind:checking {chat} />
  </span>

  {#if picking}
    <PagePicker
      {spaceKey}
      {tree}
      initial={picked}
      onCancel={() => (picking = false)}
      onDone={(next) => {
        picking = false;
        choose(next);
      }}
    />
  {/if}
</div>
