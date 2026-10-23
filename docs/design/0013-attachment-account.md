# 0013 — Every attachment accounted for, in every format

**Status:** Implemented
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-22

## Problem

A chat on a directory whose pages held Word, Excel and other files neither asked about them nor said
what became of them. Any format but text, PDF and images was dropped; so were files too long, files
not downloaded, PDFs still being read, and every image in a thorough answer or a batched review.
What was sent then said everything reached the model.

## Decision

Every attachment of a chat's pages is read, sent or named with why; a chat asks once whether to
include them; many more formats are read, with no new library (ADR-069).

## Behavior

- **Formats** (`src/spaces/documentText.ts`): Word, Excel, PowerPoint, OpenDocument and Visio files
  are opened by `src/util/zip.ts` (Node's `zlib`, with limits of 2,000 entries and 20 MB inflated)
  and read as text: paragraphs and tables, sheets as rows, slides with their notes, shape text.
  Gliffy and draw.io diagrams give their labels, compressed draw.io diagrams included; SVG, BPMN,
  RTF, email, calendar files, notebooks, code and configuration files, Mermaid and PlantUML are read;
  a zip gives its file list and the text of the files inside it. Anything else, such as older binary
  Office files, is named with why and what to do. Uploads use the same readers.
- **The account** (`attachmentsFor` in `src/spaces/attachments.ts`): for the pages an answer read,
  each file read and what as (and when it was cut), each image sent or waiting on the space's choice,
  and each file not read with why. It goes on the answer as `turn.attachments`, and its unread files
  go into the manifest as left-out entries, so What was sent names them.
- **The chat's choice**: `include` or `pages`, kept on the conversation and set with
  `PATCH /api/ai/sessions/:id`. Until it is set, attachments are read and the chat asks. With
  `pages`, the store a chat reads through (`withoutAttachments`) gives pages without attachments, an
  attachment's search section is skipped, and no image is sent.
- **Each file can be left out.** The list shows every file under its page with a box; unticking one
  adds it to the chat's `leftOutFiles` ("page id/file name"), so its text is not read
  (`AttachmentReader.of` skips it, and so does retrieval) and its image is not sent; the account
  names it as left out by you. A file that cannot be read shows its reason instead of a box.
- **New files are asked about.** Choosing records the files the chat was asked about
  (`attachmentsSeen`); a file added to its pages since, such as a page added to a Space chat, is
  marked new, and the chat asks again whether to include it. Until answered, it is read.
- **Before the first question** the coverage route returns `attachments`, judged from each file's
  name and type (`previewAccount`), so the list shows at once, before the index is built.
- **PDFs** are read before a request is built (`AttachmentReader.prepare`, up to 30 s), in chats,
  reviews, edits and the AI index; the search index's stamps include the attachments' text, so a page
  is split again once its PDF is read.
- **Thorough answers and batched reviews** account for each batch's pages and send their images, and
  a batched review now says what was sent.

| route                                              | what it adds                                       |
| -------------------------------------------------- | -------------------------------------------------- |
| `PATCH /api/ai/sessions/:id`                       | `{ attachments, leftOutFiles, attachmentsSeen }`   |
| `POST /api/space-cache/:key/metadata/coverage`     | `attachments`: the preview, with the chat's choice |
| `POST /api/ai/analyze`, `/space-cache/:key/ai/ask` | `attachments`, and images under the space's choice |

## Alternatives considered

- **A parsing library for Office files.** Declined in ADR-069: a dependency for detail the AI rarely
  needs.
- **Reading each file for the preview.** It would read every PDF of a large directory before showing
  anything; the preview judges by name and type, and each answer reports what was actually read.

## Testing

- `test/documentText.test.ts`: every format, built in the test, and each one named as not read; the
  zip limits, including a header that understates a file's size.
- `test/attachments.test.ts`: the account on an answer and in What was sent, a PDF in the first
  answer, pages only, a missing file and a missing image, the preview, and a batched review's images.
- `test/web/attachments.test.ts`: the note's wording.
