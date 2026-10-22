# 0012 — Images, diagrams and work left for a person, in review

**Status:** Implemented
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-22

## Problem

With images sent to the AI (0011), a review can see that a diagram is out of date, but an edit can
only change text. A suggestion about a diagram produced an edit with no changes, which stayed "to
decide" with nothing to press, and the edit view showed every image or diagram only as a marker.

## Decision

The AI names the work only a person can do instead of attempting it, and the edit view shows the
page's pictures (ADR-068).

## Behavior

- **Hand work.** A finding may carry `byHand`, what a person must change in Confluence, and
  `byHandOnly` when that is all of it. Both the review prompt and the chat's queue ask for them
  (`HAND_WORK_NOTE` in `src/ai/chatQueue.ts`), and `readFinding` reads them. A hand-only suggestion
  has no checkbox and `recommend` refuses it; a partly hand-work one passes that part to the edit
  model to leave alone, and the edit lists it under To do in Confluence.
- **No change.** An edit that changes nothing is `skipped`, with the model's own reason, and shows
  under Not edited in Review and in the newest run in Changes.
- **Titles.** A suggestion's page is found despite differences of case, spacing, quotes or dashes,
  and a suggestion naming a page the chat did not read says so.
- **Pictures.** `pictureOf` (`src/parser/editForm.ts`) names the attachment that shows a part: an
  attached image, or a draw.io or Gliffy diagram's `<name>.png` preview. Each `PagePart` records its
  place in the page's attachments, and the edit view shows it above the marker.

| route                                                             | what it does                                    |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| `GET /api/space-cache/:key/pages/:pageId/attachments/:attachment` | one image of a synced page that is not excluded |

## Alternatives considered

- **Uploading a redrawn image.** Declined in ADR-068: no attachment write path, no way to review it.
- **Rendering the whole page as Confluence does.** Macros are drawn by Confluence; the pictures it
  keeps are what can be shown without it.

## Testing

- `test/branchRuns.test.ts`: a no-change edit is skipped with its reason; hand work is read, refused
  when it is all of a suggestion, and passed to the edit when it is part.
- `test/chatQueue.test.ts`: titles match despite small differences; a queued suggestion keeps hand work.
- `test/attachments.test.ts`: the image route and the pictures named on an edit.
- `test/editForm.test.ts`: which parts have a picture. `test/web/*`: the notes and the rendering.
