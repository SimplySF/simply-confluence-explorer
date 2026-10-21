# 0011 — Page attachments, read with their page

**Status:** Implemented
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-21

## Problem

A sync downloaded each page's attachments, and nothing read them again, so a value only a JSON or
CSV file held, or a diagram, was invisible to every answer, review, edit and index run.

## Decision

Text attachments are read with their page; images are sent only when the space chooses (ADR-066).

## Behavior

- **Text attachments** (JSON, YAML, CSV, logs, Markdown, XML, HTML, PDF) are added to their page's
  text as `## Attachment: <name>` sections, up to 50,000 characters each and 100,000 per page
  (`src/spaces/attachments.ts`, `SpaceStore.readableMarkdown`). Chats, reviews, search, the AI index,
  edits and the chat's open edit all read them; the edit model is told not to edit them. A PDF is
  read in the background the first time and sent from the next request.
- **Images** (JPEG, PNG, GIF, WebP, up to 5 MB, 10 per page, 20 or 10 MB per request) go with their
  page only when the space's choice is `send`. The guard records them as unchecked, the manifest
  counts them, and each provider gets them in its own shape; the Gemini CLI reads them from a private
  folder named with `@` in its fixed instruction, removed after the request.
- **The choice** is `ask`, `send` or `skip` in `spaces/<KEY>/.confluencespace.json`. While it is
  `ask`, answers, edits and the coverage line say how many images the AI did not see, with **Send
  images for KEY** and **Not for KEY**.
- **Syncing** reads every attachment of a page, removes ones deleted in Confluence, and keeps two
  whose names clash.

| route                                             | what it does                                  |
| ------------------------------------------------- | --------------------------------------------- |
| `GET`/`POST /api/space-cache/:key/space-settings` | the space's choice about images: `{ images }` |
| `POST /api/space-cache/:key/metadata/coverage`    | also `images: { found, choice }` when any     |

## Alternatives considered

- **Images always.** Declined: the guard cannot check an image.
- **Describing images as text first.** It would still send each image once, to describe it.

## Testing

- `test/attachments.test.ts`: attachments reach chats, search, the index and edits; a secret in one
  stops its page; an excluded page's never leave; images go only with `send`, named as unchecked, and
  an oversized one is left out.
- `test/ai.test.ts`: the guard's report, each provider's image shape, and the CLI's private folder.
- `test/spaceCatalog.test.ts`, `test/confluence.test.ts`: the sync fixes.
