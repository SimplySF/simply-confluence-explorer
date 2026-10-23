<script lang="ts" module>
  /** A staged page waiting to be pushed, with the chat it came from when the queue spans chats. */
  export type PushRow = {
    runId: string;
    pageId: string;
    title: string;
    accepted: number;
    status: string;
    message?: string;
    chatTitle?: string;
    sessionId?: string;
    /** Where the page sits in the space, when it is known. */
    path?: string;
  };
</script>

<script lang="ts">
  import { PackageMinus, RefreshCw, Upload } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import type { BranchRun } from '../../../src/api/types.js';
  import { branches } from '../support/api.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';

  // The push queue (ADR-060): the staged pages, each with how many changes it writes. Check and push
  // checks the chosen pages first, then asks, listing what will be written and any page with a
  // problem; only the chosen pages are written, each against the version its edit was made from. In a
  // chat's review queue it is a list; on Ready to push, a table with a bar beneath it.
  type Props = {
    rows: PushRow[];
    /** The staged pages changed, so the queue is read again. */
    onChanged: () => void;
    /** Pages were written, so the tree and the page reload. */
    onPushed: () => void;
    onOpenChat?: (sessionId: string) => void;
    /** Shown as a table, with its heading above it and the push bar beneath. */
    table?: boolean;
    head?: Snippet;
    /** Says nothing when no page is staged, where the page around it says what to do instead. */
    quietWhenEmpty?: boolean;
  };

  let { rows, onChanged, onPushed, onOpenChat, table = false, head, quietWhenEmpty = false }: Props = $props();
  let unpicked = $state(new Set<string>());
  let busy = $state<'check' | 'push' | null>(null);
  let checked = $state<BranchRun[] | null>(null);
  const keyOf = (r: PushRow): string => `${r.runId}/${r.pageId}`;
  const chosen = $derived(rows.filter((r) => !unpicked.has(keyOf(r))));
  const byRun = (list: PushRow[]): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const r of list) map.set(r.runId, [...(map.get(r.runId) ?? []), r.pageId]);
    return map;
  };
  const chosenItems = $derived(
    (checked ?? []).flatMap((run) =>
      run.items.filter((i) => chosen.some((r) => r.runId === run.id && r.pageId === i.pageId)),
    ),
  );
  const ok = $derived(chosenItems.filter((i) => i.status === 'checked'));
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const changeCount = $derived(chosen.reduce((n, r) => n + r.accepted, 0));
  const allPicked = $derived(rows.length > 0 && chosen.length === rows.length);
  const failed = $derived(chosenItems.filter((i) => i.status !== 'checked'));

  const pickAll = (on: boolean): void => {
    unpicked = on ? new Set() : new Set(rows.map(keyOf));
  };

  function toggle(r: PushRow): void {
    const next = new Set(unpicked);
    if (next.has(keyOf(r))) next.delete(keyOf(r));
    else next.add(keyOf(r));
    unpicked = next;
  }

  async function check(): Promise<void> {
    busy = 'check';
    try {
      checked = await Promise.all([...byRun(chosen)].map(([runId, pageIds]) => branches.check(runId, pageIds)));
    } catch (e) {
      toast(`The check did not run: ${messageOf(e)}`, 'error');
    } finally {
      busy = null;
    }
  }

  async function push(): Promise<void> {
    const ready = ok.map((i) => ({ runId: checked!.find((r) => r.items.includes(i))!.id, pageId: i.pageId }));
    checked = null;
    busy = 'push';
    try {
      const pushed: BranchRun[] = [];
      for (const [runId, pageIds] of byRun(ready as PushRow[])) pushed.push(await branches.push(runId, pageIds)); // eslint-disable-line no-await-in-loop -- one run at a time, each page against its own version
      const written = pushed.flatMap((r) =>
        r.items.filter((i) => i.status === 'pushed' && ready.some((x) => x.pageId === i.pageId)),
      );
      const refused = pushed.flatMap((r) =>
        r.items.filter((i) => i.status === 'push-failed' && ready.some((x) => x.pageId === i.pageId)),
      );
      toast(
        [
          written.length ? `Pushed ${written.length} page${written.length === 1 ? '' : 's'} to Confluence.` : '',
          refused.length ? `Refused: ${refused.map((i) => `${i.title} (${i.message})`).join('; ')}` : '',
        ]
          .filter(Boolean)
          .join(' '),
        refused.length ? 'error' : 'success',
      );
      onPushed();
    } catch (e) {
      toast(`The push stopped: ${messageOf(e)}`, 'error');
    } finally {
      busy = null;
      onChanged();
    }
  }

  async function unstage(r: PushRow): Promise<void> {
    try {
      await branches.stage(r.runId, r.pageId, false);
      onChanged();
    } catch (e) {
      toast(messageOf(e), 'error');
    }
  }
</script>

{#snippet pushButton(big: boolean)}
  <button class={['btn btn-primary', big && 'push-go']} disabled={!chosen.length || !!busy} onclick={check}>
    {#if busy}<RefreshCw size={14} class="spin" />{:else}<Upload size={14} />{/if}
    Check and push {chosen.length}
  </button>
{/snippet}

{#snippet fromChat(r: PushRow)}
  {#if r.sessionId && onOpenChat}
    <button class="link-btn" onclick={() => onOpenChat(r.sessionId!)}>{r.chatTitle}</button>
  {:else}{r.chatTitle}{/if}
{/snippet}

{#if table}
  <div class="push-body">
    {@render head?.()}
    {#if rows.length === 0 && quietWhenEmpty}
      <!-- The page around the queue says what to do. -->
    {:else if rows.length === 0}
      <div class="empty-state">
        <Upload size={28} />
        <strong>Nothing staged</strong>
        <p>Decide an edit in a chat's review queue and stage it. Staged pages wait here until you push them.</p>
      </div>
    {:else}
      <div class="push-table" role="table" aria-label="Staged pages">
        <div class="push-table-row push-table-head" role="row">
          <span role="columnheader">
            <input
              type="checkbox"
              checked={allPicked}
              aria-label="Choose every page"
              onchange={(e) => pickAll(e.currentTarget.checked)}
            />
          </span>
          <span role="columnheader">Page</span>
          <span role="columnheader">Changes</span>
          <span role="columnheader">From chat</span>
          <span role="columnheader"><span class="visually-hidden">Unstage</span></span>
        </div>
        {#each rows as r (keyOf(r))}
          <div class="push-table-row" role="row">
            <span role="cell">
              <input
                type="checkbox"
                checked={!unpicked.has(keyOf(r))}
                aria-label="Push {r.title}"
                onchange={() => toggle(r)}
              />
            </span>
            <span role="cell" class="push-page">
              <strong>{r.title}</strong>
              {#if r.path}<span class="push-path">{r.path}</span>{/if}
              {#if r.message}<span class="branch-error">{r.message}</span>{/if}
            </span>
            <span role="cell" class="push-muted">{plural(r.accepted, 'accepted change')}</span>
            <span role="cell" class="push-chat"
              >{#if r.chatTitle}{@render fromChat(r)}{/if}</span
            >
            <span role="cell">
              <button class="btn btn-secondary btn-xs" disabled={!!busy} onclick={() => unstage(r)}>
                <PackageMinus size={12} /> Unstage
              </button>
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
  {#if rows.length}
    <div class="push-bar">
      <div class="push-bar-inner">
        <span class="branch-note">
          {chosen.length} of {plural(rows.length, 'page')} selected · {plural(changeCount, 'change')}. Nothing is
          written until you confirm.
        </span>
        {@render pushButton(true)}
      </div>
    </div>
  {/if}
{:else if rows.length === 0}
  <div class="empty-state review-empty">
    <Upload size={24} />
    <strong>Nothing staged</strong>
    <p>
      Open an edit under Edits to decide, decide its changes, and stage it. Staged pages wait here until you push them.
    </p>
  </div>
{:else}
  <ul class="push-list">
    {#each rows as r (keyOf(r))}
      <li>
        <label class="review-check">
          <input type="checkbox" checked={!unpicked.has(keyOf(r))} onchange={() => toggle(r)} />
          <strong>{r.title}</strong>
        </label>
        <span class="branch-note">{plural(r.accepted, 'accepted change')}</span>
        {#if r.chatTitle}<span class="branch-note">from {@render fromChat(r)}</span>{/if}
        {#if r.message}<span class="branch-error">{r.message}</span>{/if}
        <span class="queue-spacer"></span>
        <button class="btn btn-secondary btn-xs" disabled={!!busy} onclick={() => unstage(r)}>
          <PackageMinus size={12} /> Unstage
        </button>
      </li>
    {/each}
  </ul>
  <div class="review-footer">
    <span class="branch-note">Nothing is written until you confirm.</span>
    {@render pushButton(false)}
  </div>
{/if}

{#if checked}
  <ConfirmDialog
    title={ok.length ? `Update ${ok.length} page${ok.length === 1 ? '' : 's'} in Confluence?` : 'Nothing can be pushed'}
    onConfirm={() => (ok.length ? void push() : (checked = null))}
    onCancel={() => (checked = null)}
  >
    {#snippet confirmLabel()}<Upload size={14} /> {ok.length ? 'Push' : 'Close'}{/snippet}
    {#if ok.length}
      <p>Each page's accepted changes are written; nothing else on the page changes.</p>
      <ul>
        {#each ok as i (i.pageId)}<li>
            {i.title}: {i.changes?.filter((c) => c.decision === 'accepted').length} accepted
          </li>{/each}
      </ul>
    {/if}
    {#if failed.length}
      <p class="branch-note">Not pushed, because the check found a problem:</p>
      <ul>
        {#each failed as i (i.pageId)}<li>{i.title}: {i.message}</li>{/each}
      </ul>
    {/if}
    <p class="branch-note">A page someone changed since its edit was made is refused, not overwritten.</p>
  </ConfirmDialog>
{/if}
