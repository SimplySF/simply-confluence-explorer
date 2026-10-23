# 0015 — An app that keeps up, says when to wait, and gives review a place of its own

**Status:** Implemented
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-23

## Problem

On a real space of about 3,200 pages, every action lagged: opening chats, adding a page to a chat,
which seemed to do nothing until a new chat appeared half a minute later, attachment options
arriving minutes late and partway through a conversation, and Observability. Nothing said to wait. The server
answers on one thread, and requests read the whole space from disk several times each, so one slow
request held every other; the freeze it caused was reported as "The server could not answer anything
for 2.4 s", which a person could not act on. The chat, its history, the page tree and a review queue
beside it made four columns, too busy even on a large screen.

## Decision

The server stops reading what it already knows, and runs what cannot be cut into small pieces on
worker threads (ADR-074). Every action that waits shows that it does, and a chat holds its questions
until its pages are checked. A freeze is recorded with what was running, for diagnosis, and not
raised to the person (ADR-073). Review becomes its own full-window place, opened from a chat or from
the sidebar's Review page. The budgets rise for it (ADR-075).

## Behavior

- **What the server keeps**: each exclusion rule compiled once, and each page's answer until the
  rules change (`checker` in `spaces/exclusionManager.ts`); a space's page ids until its folder
  changes, and a page's attachment list until it changes (`spaces/spaceStore.ts`); each
  conversation as last read, by its file's time and size (`ai/sessions.ts`).
- **Coverage** (`routes/ai.ts`): a chat's chosen pages are read once, only those chosen, and shared
  by the attachment list, the count and the size; a space still being indexed is answered at once
  with the build's progress.
- **Worker threads** (`workers/pool.ts`, `workers/tasks.ts`): PDFs and the zip-based Office formats
  are read on them, ahead of a request and before the search index is built, and so are the
  Observability page's queries of the telemetry files.
- **Waiting, shown**: a page added to a chat shows at once, marked as saving; while a chat's pages
  are checked or its space indexed, its scope bar says so with the progress and Send waits with the
  reason (`chatWaiting` in `support/pages.ts`); opening a chat, the list of chats, each
  Observability view and the buttons that start work show that they are working.
- **Review** (`ReviewFlow.svelte`, `ReviewHub.svelte`, `support/review.ts`): a bar above a chat's
  question box says what its review holds and opens it. The review fills the window in four steps,
  Review, Edit, Stage and Push, with the question box at the bottom; Exit goes back to the chat, or
  to the Review page when opened from there. The Review page lists the chats with work waiting, from
  `GET /api/space-cache/:key/reviews`, and every staged page to push together. A review's menu, on
  the Review page or in the review, clears it (`POST /api/ai/sessions/:id/review/clear` dismisses
  its suggestions and sets aside and unstages its edits not pushed, refused while one is written)
  or deletes the chat. The list of chats in Space chat folds to a strip.

| action on the realistic 3,200-page space           | before   | after |
| -------------------------------------------------- | -------- | ----- |
| a chat's coverage, first answer                    | 1,964 ms | 91 ms |
| a chat's coverage, again                           | 274 ms   | 5 ms  |
| the tags                                           | 122 ms   | 5 ms  |
| the longest the server kept a health check waiting | 274 ms   | 68 ms |

## Alternatives considered

- **Threads for everything.** Reading a large space is already cut into pieces that let other
  requests through; moving it to a thread would copy the space between threads to save little, and
  the waste it repeated is now gone instead.
- **Letting a question go before the check.** The attachment question and the index would then
  arrive partway through a conversation, which is the surprise this removes.
- **Keeping the review beside the chat.** Four columns were too busy, and a side-by-side decision
  never fitted the lane.

## Testing

- `test/exclusions.test.ts`: a changed rule applies at once after a pass, and a pass agrees with
  checking each page alone.
- `test/sessions.test.ts`: a conversation changed on disk is read again, and what the store hands
  out cannot change what it keeps; coverage is asked again until the index is built.
- `test/workers.test.ts`: a thread reads a workbook, a PDF and the telemetry as the main thread does,
  a thread that stops fails its task with the reason, and a thread loads nothing that sends anything.
- `test/telemetry.test.ts`: a freeze names the request that held the server and the jobs running.
- `test/chatQueue.test.ts`: clearing a review leaves nothing waiting and pushed pages as they are,
  is refused while an edit is written, and a deleted chat takes its review and staged pages with it.
- `test/web/review.test.ts`, `test/web/pages.test.ts`, `test/web/problems.test.ts`: the steps, what a
  chat waits for, and the header leaving freezes out.
- `test/scale/responsiveness.scale.ts`: the times above, run with `pnpm run test:scale`.
