# 0005 — Writing to Confluence: a push, a branch's review queue, and a new page

**Status:** Planned
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-15

## Problem

The app changes pages other people read. A change nobody accepted, or one made from a stale copy,
is the failure the north star names first.

## Decision

Three ways to write, one write path. `src/confluence/pagePush.ts` updates a page through
simply-atlassian-core's page-update functions in process (ADR-028); branch runs and drafts call it
or the library's page-create function, and nothing else writes.

## Behavior

| route                               | what                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| `POST /api/pages/:pageId/recommend` | a proposed revision with a chosen focus                    |
| `POST /api/pages/:pageId/dry-run`   | convert without writing; report what the converter rejects |
| `POST /api/pages/:pageId/push`      | write, naming the version the proposal was made from       |
| `/api/branches/runs/...`            | review or improve a branch; accept, edit, reject; push     |
| `/api/drafts/...`                   | a new page: redundancy check, co-writing, create           |

- **A push names its base version.** If the page has moved on, the push is refused with "changed
  since"; nothing is merged.
- Frontmatter is stripped before converting. After a push, the local copy's body and version are
  refreshed from what Confluence now holds.
- **A branch queue writes only pages a person accepted**, one at a time, and reports each result
  (ADR-024). It survives a restart.
- **A page is created only after the redundancy check has been answered** (ADR-025). A duplicate
  title is reported as such.

## Alternatives considered

- **Keep the separate push tool.** Declined in ADR-028: the library it is built on does the same
  work without starting a process.

## Implementation plan

Its own pull request, after AI, flagged as load-bearing.

## Testing

End-to-end against the Data Center test environment: a push changes the page and bumps its version;
a stale base version is refused; a branch push changes only the accepted pages; a draft creates its
page under the chosen parent, and a near-duplicate of an existing page is flagged. The unit tests
for the version check and frontmatter strip carry over.

## Open questions

- None.
