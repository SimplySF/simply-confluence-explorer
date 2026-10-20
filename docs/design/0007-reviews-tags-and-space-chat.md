# 0007 — Chat as the place to work: contexts, a context engine, a change queue, and new pages from GitLab

**Status:** Implemented (PR #24)
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
- **A chat's pages are a corpus of any size** (ADR-051). One that fits a request is read in full;
  otherwise each question retrieves the sections it needs, by keywords, metadata and embeddings.
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
| `POST /api/ai/sessions/:id/suggest`              | Asks for suggestions; too many pages for one request start a batched review.     |
| `GET /api/ai/batches/:jobId`, `POST .../cancel`  | A batched review's progress, and stopping it.                                    |
| `POST /api/ai/sessions/:id/turns/:turn/queue`    | Stages an edit of each page the chosen suggestions of that answer name.          |
| `GET /api/space-cache/:spaceKey/tags`            | Lists each tag with the pages that carry it, leaving out excluded pages.         |
| `GET /api/space-cache/:spaceKey/sync/active`     | Reports a running sync, so a reloaded browser picks its progress up again.       |
| `GET`/`PUT /api/gitlab`, `POST /api/gitlab/test` | Reads, saves and tests the GitLab connection; the token is never returned.       |

- **Corpora.** Chosen pages are directories (each with everything under it at the time of asking),
  tags and single pages, all in the space and allowed by the exclusion rules, checked on every turn.
- **Retrieval** splits pages into sections at their headings (`src/spaces/sections.ts`). It ranks
  sections by BM25 and, when embeddings exist, by meaning, merges the two rankings, and lets the AI
  pick 12 of the best 40 from their headings and summaries. Each answer names what it read and why.
- **The index** is metadata version 2 (section summaries, questions answered, shared topics) and
  embeddings, built by one background job that redoes only pages changed since.
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

Route tests against the fake Confluence and a fake GitLab cover: corpora refusing an excluded page
or one from another space; retrieval sending only chosen sections of a large corpus; the engine sending metadata only when choosing,
and falling back to search; queueing only stored suggestions, each edit carrying only its own; a
GitLab link on another host refused and the token never returned; a series created in order.

## Open questions

- None.
