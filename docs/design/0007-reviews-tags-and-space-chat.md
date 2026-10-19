# 0007 — Chat as the place to work: contexts, a context engine, a change queue, and new pages from GitLab

**Status:** Planned
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-19

## Problem

People work on one page, on a directory, on pages about one subject spread over a space, or on the
whole space, and they want to talk it through and then change pages from the conversation. An admin
looks for repeated pages across directories; an engineer on call searches an unfamiliar space; a
lead writes a service's pages from its repository. The app had separate shapes for each, and long
work such as AI summaries lost its progress as soon as the person opened another page.

## Decision

- **Chat is the place to work** (ADR-049). Every chat has a context: this page, a directory, chosen
  pages (from tags or added by hand), or the whole space. The page has Read, Chat and Details tabs.
- **A whole-space question asks the AI which pages to read** from their summaries, then reads them
  (ADR-048).
- **Suggestions become a change queue.** An answer's suggestions are stored on the server with the
  turn; the ticked ones become one edit per page, reviewed and pushed as before (ADR-024).
- **New pages** can follow an example page or template, read GitLab repositories (ADR-050), and be a
  series: an overview page and its children.
- **Background work** (sync, summaries, edits being written) is shown in the header, and every AI
  request can be stopped (ADR-047).

## Behavior

| route                                            | what it does                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `PATCH /api/ai/sessions/:id`                     | Renames a chat, or changes its context between the whole space and chosen pages. |
| `POST /api/ai/sessions/:id/turns/:turn/queue`    | Stages an edit of each page the chosen suggestions of that answer name.          |
| `GET /api/space-cache/:spaceKey/tags`            | Lists each tag with the pages that carry it, leaving out excluded pages.         |
| `GET /api/space-cache/:spaceKey/sync/active`     | Reports a running sync, so a reloaded browser picks its progress up again.       |
| `GET`/`PUT /api/gitlab`, `POST /api/gitlab/test` | Reads, saves and tests the GitLab connection; the token is never returned.       |

- **Contexts.** A chosen-pages chat holds at most 50 page ids, all in its space and allowed by the
  exclusion rules; every turn checks each page again (`contextCollector`). A directory chat reads
  the page and everything under it.
- **The context engine** finds 25 candidates with the BM25 index (`src/spaces/searchIndex.ts`), asks
  the AI to choose up to 8 from their metadata, then reads them with the pages earlier answers used,
  up to the context limit. Each answer names what it read and why.
- **Suggestions** have a kind, the pages they name, what is wrong and what to do; one that needs a
  page moved or written is shown but cannot be queued. Queueing reads them from the stored turn,
  never from the browser, and edits each page from its current version.
- **GitLab** links are read only on the configured host, within limits on files and characters, and
  pass the outbound guard.
- **A series** is checked for similar pages by every title, dry-run in full, then created overview
  first; a failure partway names what was created and keeps the rest as a draft.
- **Summaries** can be generated for any chat's pages, and a chat says how many of its pages have one.

## Alternatives considered

- **A separate review screen beside chat.** Tried in this pull request and declined: it split the
  same work across two places, and could not pick a directory's pages or a tag's.
- **Pinning pages to a whole-space chat.** Declined: "chosen pages" says the same thing plainly.

## Implementation plan

One pull request, one commit per change, flagged as load-bearing: it touches the write path's
queue, what is sent to an AI, callers of `isPageExcluded`, and a second outbound connection.

## Testing

Route tests against the fake Confluence and a fake GitLab cover: chosen-pages contexts refusing an
excluded page, one from another space or too many; the engine sending metadata only when choosing,
and falling back to search; queueing only stored suggestions, each edit carrying only its own; a
GitLab link on another host refused and the token never returned; a series created in order.

## Open questions

- None.
