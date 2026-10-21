# 0009 — Changing pages that hold macros, change by change

**Status:** Implemented
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-20

## Problem

A push replaced a page's whole body with storage converted from Markdown, so any page holding a
macro, an image, a page link, a mention, a task list or a layout was refused (ADR-041). That is most
real pages. A page's edit was also accepted or rejected as a whole, and the person's own edits
overwrote the AI's version.

## Decision

Pages are edited through an edit form that keeps every part Markdown cannot carry (ADR-058), and each
change in an edit is accepted or rejected on its own (ADR-059).

## Behavior

- **The edit form** (`src/parser/editForm.ts`) is the page's text with a numbered marker for each
  part: `⟦1 toc⟧`, `⟦4 status: LIVE⟧`, `⟦6 image: chart.png⟧`. A panel, an expand section or a
  layout column is a pair, `⟦2 info: Heads up⟧ … ⟦/2⟧`, around text that stays editable. A block
  whose text cannot be written back unchanged is one marker, `⟦8 table, kept as it is⟧`.
- **A push** writes each untouched block exactly as Confluence holds it, converts each changed block,
  and puts each part back at its marker. A part missing from the result refuses the write unless the
  person accepted the change that removes it.
- **A change** (`src/branches/pageChanges.ts`) is a run of blocks in which the working text differs
  from the page. A rewritten paragraph is one change; a marker on its own line is always its own
  change, so removing a macro is decided apart from the text around it. Each change says whether the
  AI or the person made it, what it removes, and any formatting the rewritten block cannot keep.

| route                                                             | what it does                               |
| ----------------------------------------------------------------- | ------------------------------------------ |
| `PATCH /api/branches/runs/:runId/items/:pageId/changes/:changeId` | accepts, rejects or undoes one change      |
| `POST /api/branches/runs/:runId/items/:pageId/decide-all`         | accepts or rejects every change of a page  |
| `PUT /api/branches/runs/:runId/items/:pageId/text`                | saves the person's own edits               |
| `POST /api/branches/runs/:runId/items/:pageId/reset`              | puts the text back to the AI's edit        |
| `POST /api/branches/runs/:runId/items/:pageId/redo`               | makes the edit again from the current page |

The review screen lists the changes as cards with Accept, Reject and Undo. **What will be written**
shows the page with only the accepted changes. **Check and push** checks the pages, then lists what
will be written and what failed, with why.

## Alternatives considered

- **Asking the model for storage format.** A model writes macro markup almost right, which Confluence
  refuses or renders wrongly, and the person could not read or edit it.
- **Deciding each suggestion.** Declined in ADR-059: one rewrite applies them all, so the text does
  not say which words came from which.

## Testing

- `test/editForm.test.ts`: every dataset page rebuilds byte for byte; a change rewrites only its
  block; parts survive a move; a panel's and a column's text are edited in place; each refusal fires.
- `test/branchRuns.test.ts`: only accepted changes are written, the toc unchanged; decisions survive
  an unrelated edit; reset; a removal is written only once accepted; redo after a colleague's edit.
- `test/e2e/push.e2e.ts`: a page with a warning panel is changed in a real Confluence, panel intact.
