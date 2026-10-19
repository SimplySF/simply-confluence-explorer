# 0007 — Reviews you act on, pages by tag, Space chat, and work that runs in the background

**Status:** Planned
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-19

## Problem

A person improving documentation wants a list of what is wrong, to pick what to fix, and to check
each change before it is written. The app had three shapes for this (ADR-046), none of them that
one. Pages about one subject also sit in different parts of a space, where nothing can gather them;
a question about the whole space was asked from inside one page; and long work such as AI summaries
lost its progress as soon as the person opened another page.

## Decision

- **One review flow** for a page, a section (a page and everything under it) and a tag (ADR-046). It
  is one kind of run on the server (`src/branches/branchRuns.ts`) and one set of parts in the
  browser, shown inline on the Improve tab and in the Review dialog.
- **Tags** are a page's AI tags together with its Confluence labels, lower-cased. The sidebar
  switches between the page tree and the list of tags.
- **Space chat** is its own view, with the space's saved conversations listed beside it. Ask AI on
  a page is about the page, or the page and its sub-pages.
- **Background work** (sync, AI summaries, reviews) is held in one store in the browser
  (`web/src/support/jobs.svelte.ts`) rather than in the component that started it, and the header
  shows what is running.
- **Every AI request can be stopped** (ADR-047).

## Behavior

| route                                        | what it does                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /api/branches/runs`                    | Starts a review of `pageIds`, chosen from a page, a section or a tag, for the aspects ticked. |
| `POST /api/branches/runs/:runId/apply`       | Stages an edit of each page that the chosen suggestions name, with only those suggestions.    |
| `GET /api/space-cache/:spaceKey/tags`        | Lists each tag with the pages that carry it, leaving out excluded pages.                      |
| `GET /api/space-cache/:spaceKey/sync/active` | Reports a sync that is running, so a reloaded browser picks its progress up again.            |
| `PATCH /api/ai/sessions/:id`                 | Renames a conversation.                                                                       |

- **A review** checks each page as a section's pages are checked: the exclusion rules, then the
  secrets check, then the size limit (`src/spaces/branchContext.ts`). It accepts at most 50 pages,
  all from one space, and refuses a page outside the section or without the tag. Its suggestions
  have a kind, the pages they name, what is wrong and what to do; `placement` and `gap` suggestions
  need a page moved or written, so they are shown but cannot be applied.
- **Applying** reads the suggestions from the saved run, never from the browser, checks each page
  again, and makes one edit per page from its current version. The edits are a new run linked to
  the review, decided page by page and pushed through `pagePush.ts` as before (ADR-024, ADR-041).
- **Tagged pages** can be reviewed, or asked about together in a conversation whose scope is that
  list of pages; every page is checked again on every turn.
- **Space chat** finds pages with the BM25 index (`src/spaces/searchIndex.ts`) over titles, tags,
  summaries and text, searching on the question and the one before it, keeps the pages earlier
  turns used, and fills the context up to its limit. Each answer names its sources. Pages can be
  pinned to the conversation. Conversations are kept in `data/sessions/` and can be renamed and
  deleted.
- **A summary run or a sync** is never started twice for the same space: a second request gets the
  one already running. The tree of a newly loaded space starts collapsed.

## Alternatives considered

- **A separate "pages" run beside the section review.** Declined: the two would drift, and the
  maintainer asked for them to behave the same.
- **A search over the whole space with no limit on pages.** Declined: the context limit
  (ADR-023) is what keeps a request's size and cost predictable.

## Implementation plan

One pull request, one commit per change, flagged as load-bearing: it touches the write path's
queue, what is sent to an AI, and callers of `isPageExcluded`.

## Testing

Route tests against the fake Confluence cover: a second summary run or sync returning the first; a
stopped review keeping no findings; a stopped chat adding no turn; applying only the chosen
suggestions to only the pages they name; an excluded page, a page from another space, a page
outside its section or without its tag being refused; and the tag list leaving out excluded pages.

## Open questions

- None.
