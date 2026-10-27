# 0016 — A Space chat's pages are chosen from the space's tree, leaving out what does not belong

**Status:** Implemented
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-27

## Problem

A person asked to find repetition in a directory of more than 200 pages, about 50 of them change
request templates that need no review, could take the directory whole or add its pages one by one
from a search that showed eight results. Nothing let them take a directory and leave part of it out.

## Decision

A Space chat's pages are chosen in a full-window picker over the space's tree, with a box for each
page, the space's tags, and rules that leave out pages by title. What is left out is stored, as with
a chat's attachments, so a page added later under a chosen directory is read, unless it sits under a
page left out or its title matches a rule.

## Behavior

- **The scope** (`SessionScope`, kind `pages`) gains `leftOut`, page ids each left out with everything
  under it, and `leaveOutTitles`, words that leave out any chosen page whose title holds them, ignoring
  case. `corpusPages` (`src/spaces/corpus.ts`) applies both after the directories, pages and tags are
  gathered and before the space's exclusion rules, so leaving out only ever removes pages; `chosenOf`
  reads the same fields, so the coverage count and an index run agree with the chat.
- **The picker** (`PagePicker.svelte`, logic in `support/choice.ts`) opens from **Choose pages…** in the
  chat's scope row. Ticking a page with sub-pages takes it as a directory, and a page without them
  alone; unticking a page inside a ticked directory leaves it out; a parent is part-ticked when part
  of what is under it is not read. The tree opens folded, filters by title, and shows only what is
  unfolded, so a large space stays quick. **Done** saves; **Cancel** and Esc keep the choice as it was.
- **The scope row** names each directory with how many pages are left out of it, and each rule as a
  chip that can be removed.

| route                                          | what changes                                   |
| ---------------------------------------------- | ---------------------------------------------- |
| `POST`/`PATCH /api/ai/sessions`                | a `pages` scope may carry `leftOut` and rules  |
| `POST /api/space-cache/:key/metadata/coverage` | counts the chosen pages without those left out |

## Alternatives considered

- **A fixed list of the pages to read.** It would read nothing added under a directory later, which
  a directory chosen today does.
- **Leaving out by title as a one-time untick.** Templates added later would then be read; a rule
  keeps them out, and it shows as a chip so it is never hidden.

## Testing

- `test/web/choice.test.ts`: ticking, unticking, part-ticked parents, rules, the counts, and that the
  browser's title rule agrees with the server's.
- `test/sessions.test.ts`: a directory is read without the pages left out or matching a rule, a page
  added later matching the rule stays out, the coverage count agrees, and the limits are checked.
- `test/web/tree.test.ts`: the tree rows the sidebar and the picker share.
