# 0010 — A chat's queues: review, changes and push, from the live page

**Status:** Implemented
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-21

## Problem

A chat's suggestions were tick boxes on the answer that made them, and edits were reviewed inline
below it, so one piece of work was spread down the conversation. The chat could not change a
suggestion it had made, and an edit was built from the copy on this machine, which may be older
than the page in Confluence.

## Decision

Each chat owns a review queue and the edits made from it, shown as tabs of the chat (ADR-060), and
each edit starts from the page as Confluence holds it now (ADR-061).

## Behavior

- **Review** lists the chat's suggestions, grouped by page, with their state: open, being edited,
  edited, already done, no longer relevant or dismissed. Asking the chat to add, reword or remove a
  suggestion changes the list; an earlier wording can be put back. **Recommend changes** makes one
  edit for each page the ticked suggestions name.
- **Before an edit,** the page is read from Confluence, the copy on this machine is updated if it is
  older, and each suggestion made before the page changed is checked: only those that still apply
  are edited, and the rest return to Review with why.
- **Changes** lists the edits. Opening one shows the page and the edit side by side, each change with
  Accept, Reject or Undo between them, and the AI's recommendation beside them. **Work on this edit
  in the chat** makes the next question about that edit; the chat's revised text is accepted into the
  edit or dismissed. **Stage** is enabled once every change is decided.
- **Push** lists the staged pages. **Check and push** checks the chosen pages, then asks, and writes
  only those. **Ready to push** in the sidebar shows every staged page in the space.

| route                                                        | what it does                                       |
| ------------------------------------------------------------ | -------------------------------------------------- |
| `GET /api/ai/sessions/:id/queue`                             | the chat's suggestions with their state, and runs  |
| `POST /api/ai/sessions/:id/suggestions/recommend`            | `{ids}`: edits from the picked suggestions         |
| `POST /api/ai/sessions/:id/suggestions/dismiss`              | `{ids, undo?}`                                     |
| `POST /api/ai/sessions/:id/suggestions/:suggestionId/revert` | `{to}`: puts back an earlier wording               |
| `POST /api/ai/sessions/:id/turns/:turn/accept-edit`          | puts the chat's revised edit into the working text |
| `POST /api/ai/sessions/:id/turns/:turn/close-proposal`       | dismisses that revision                            |
| `POST /api/branches/runs/:runId/items/:pageId/stage`         | `{staged}`                                         |
| `POST /api/branches/runs/:runId/check`, `…/push`             | `{pageIds?}`: only the staged pages named          |
| `GET /api/space-cache/:spaceKey/staged`                      | staged pages across the space's chats              |

`POST /api/ai/sessions/:id/messages` takes `focus: {runId, pageId}` for the open edit.

## Alternatives considered

- **A queues page apart from the chat.** Declined in design: the chat must be able to rework the
  queue, so the queue sits in the chat, which also answers design doc 0007's refusal.
- **A thread per edit.** One conversation keeps every reason for a change in one history.

## Testing

- `test/chatQueue.test.ts`: the chat rewords, adds and removes suggestions, and an earlier wording
  comes back; an old chat's suggestions move to its queue; an edit is made from the newer page, a
  suggestion already done is not applied, and an unchanged page is not asked about again; a revised
  edit is accepted or dismissed, and its page is checked on every turn; only staged pages are
  pushed, a push names which, and the space's staged pages never list an excluded one.
- `test/branchRuns.test.ts`: recommending, refusals, and a run interrupted by a restart.
