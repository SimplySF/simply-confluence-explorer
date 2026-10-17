# 0005 — Writing to Confluence: a push, a branch's review queue, and a new page

**Status:** Implemented (PR #11)
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-15

## Problem

The app changes pages that other people read and rely on. Two kinds of change would do real harm: a
change that no person accepted, and a change made from an out-of-date copy of the page, which would
silently overwrite someone else's edits. The north star names the first of these as a sign that the
project has failed.

## Decision

The app has three ways to write to Confluence, and all of them go through a single write path.

- `src/confluence/pagePush.ts` updates a page, using simply-atlassian-core's page-update functions
  directly in the server process (ADR-028).
- Branch runs and new-page drafts write either by calling `pagePush.ts` or by calling the library's
  page-create function.
- Nothing else in the app writes to Confluence. A reviewer who wants to know everything the app can
  change only has to read these modules.

## Behavior

| route                               | what it does                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/pages/:pageId/recommend` | Asks the AI for a proposed revision of the page, with a focus the person chooses.                                                 |
| `POST /api/pages/:pageId/dry-run`   | Converts the proposal to Confluence's format without writing it, and reports anything the converter rejects.                      |
| `POST /api/pages/:pageId/push`      | Writes the proposal to Confluence, stating which version of the page it was made from.                                            |
| `/api/branches/runs/...`            | Reviews or improves a branch (a page and everything under it); accepts, edits or rejects each page; and pushes the accepted ones. |
| `/api/drafts/...`                   | Creates a new page: runs the redundancy check, supports writing the page with the AI, and creates it.                             |

- **A proposal is made from the server's own copy of the page**, after the exclusion check, as a
  question is (ADR-037), and it returns the version it was made from, which the push then names.
- **A push states the version it was made from.** If the page has changed in Confluence since the
  proposal was made, the push is refused with a "changed since" message. The app never tries to
  merge the two versions, because a merge could quietly drop someone else's edit.
- **A page is never written from Markdown if Markdown cannot carry all of it** (ADR-041). Markdown
  has no form for an image, a macro such as a status label or a panel, a link to another page, a
  mention or a task list, so the converted page shows each as placeholder text. Writing that text
  back would replace the real thing, so the dry run and the push refuse such a page and name what it
  would lose.
- **The page on disk is kept accurate.** Frontmatter, the block of metadata at the top of each saved
  page, is removed before the page is converted, so it never ends up in Confluence. After a push,
  the local copy's body and version are refreshed from what Confluence now holds.
- **A branch's queue writes only the pages a person accepted.** It pushes them one at a time and
  reports the result for each page (ADR-024). The queue is saved to disk, so it survives a restart
  of the server.
- **A new page is created only after the redundancy check has been answered** (ADR-025). The check
  looks for existing pages that already cover the same topic, and the author must decide what to do
  about them. If the title is already taken, the app reports that the title is a duplicate.

## Alternatives considered

- **Keep calling the separate push tool.** Declined in ADR-028. The library that the tool is built
  on does the same work without starting a separate process.

## Implementation plan

This lands as its own pull request, after the AI work. It is flagged as load-bearing, because it
changes the code that writes to Confluence, and it gets human review before release.

## Testing

The end-to-end suite runs these checks against the Data Center test environment:

- a push changes the page and increases its version number;
- a push based on an out-of-date version is refused;
- pushing a branch changes only the pages that were accepted;
- a draft creates its page under the chosen parent page;
- a draft that closely repeats an existing page is flagged.

The unit tests for the version check and for removing frontmatter carry over unchanged.

## Open questions

- None.
