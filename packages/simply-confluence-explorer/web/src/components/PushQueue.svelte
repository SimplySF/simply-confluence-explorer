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
  };
</script>

<script lang="ts">
  import { PackageMinus, RefreshCw, Upload } from '@lucide/svelte';
  import type { BranchRun } from '../../../src/api/types.js';
  import { branches } from '../support/api.js';
  import { messageOf, toast } from '../support/toast.svelte.js';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';

  // The push queue (ADR-060): the staged pages, each with how many changes it writes. Check and push
  // checks the chosen pages first, then asks, listing what will be written and any page with a
  // problem; only the chosen pages are written, each against the version its edit was made from.
  type Props = {
    rows: PushRow[];
    /** The staged pages changed, so the queue is read again. */
    onChanged: () => void;
    /** Pages were written, so the tree and the page reload. */
    onPushed: () => void;
    onOpenChat?: (sessionId: string) => void;
  };

  let { rows, onChanged, onPushed, onOpenChat }: Props = $props();
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
  const failed = $derived(chosenItems.filter((i) => i.status !== 'checked'));

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

{#if rows.length === 0}
  <div class="empty-state">
    <Upload size={28} />
    <strong>Nothing staged</strong>
    <p>Open an edit under Changes, decide its changes, and stage it. Staged pages wait here until you push them.</p>
  </div>
{:else}
  <ul class="push-list">
    {#each rows as r (keyOf(r))}
      <li>
        <label class="review-check">
          <input type="checkbox" checked={!unpicked.has(keyOf(r))} onchange={() => toggle(r)} />
          <strong>{r.title}</strong>
        </label>
        <span class="branch-note">{r.accepted} accepted change{r.accepted === 1 ? '' : 's'}</span>
        {#if r.chatTitle}
          <span class="branch-note"
            >from
            {#if r.sessionId && onOpenChat}
              <button class="link-btn" onclick={() => onOpenChat(r.sessionId!)}>{r.chatTitle}</button>
            {:else}{r.chatTitle}{/if}</span
          >
        {/if}
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
    <button class="btn btn-primary" disabled={!chosen.length || !!busy} onclick={check}>
      {#if busy}<RefreshCw size={14} class="spin" />{:else}<Upload size={14} />{/if}
      Check and push {chosen.length}
    </button>
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
