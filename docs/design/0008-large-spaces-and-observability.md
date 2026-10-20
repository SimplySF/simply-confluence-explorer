# 0008 — Large spaces: packed indexing, context checks, thorough answers, and observability

**Status:** Implemented (PR #30)
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-20

## Problem

The space the app is built for has about 3,200 pages and uses the Gemini CLI, which has no
embeddings and starts a process for every request. Indexing it took one request per page, one at a
time, which is most of a day. A question read at most 12 sections, so a broad one could not be
answered fully. Nothing showed whether the context meant for the model reached it, a question showed
only "Thinking…" for up to a minute, and failures were counted but never explained.

## Decision

- **Indexing sends packs of pages** and runs a few requests at once, retrying and recording each
  failure with its reason (ADR-054).
- **Every request carries a context manifest**, checked against what is sent; cut-off answers are
  reported.
- **Retrieval stems words and flags weak matches**, and a retrieval measurement guards its quality.
  An embedding provider can be set apart from the chat provider.
- **"Answer thoroughly"** reads many sections in batches and combines their notes.
- **The search index builds in the background**, and a question shows the step it is on.
- **The app keeps traces, logs and a few health numbers**, shown on an Observability page.

## Behavior

| route                                | what it does                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `GET /api/observe/now`               | Running jobs, requests in flight, the index build, event-loop lag and charts.        |
| `GET /api/observe/logs`              | Events with filters, facet counts, repeated messages grouped, and paging.            |
| `GET /api/observe/traces/:traceId`   | The spans of one trace.                                                              |
| `GET /api/ai/sessions/:id/activity`  | The step a question is on while it is being answered.                                |
| `POST /api/ai/sessions/:id/messages` | With `thorough: true`, starts a thorough answer on a chat too large for one request. |

- **The manifest** lists each item meant for the model (pages, sections, files, earlier turns, the
  question) with its size, whether it was included, and why not. Each answer shows it under **What
  was sent**, and the engine refuses a request whose included items are missing from its payload.
- **Packed indexing** fits small pages together up to about 60,000 characters; every page id must
  come back, or that page is retried alone and then recorded as failed. The Space menu estimates the
  requests a run takes, and Settings sets how many run at once.
- **A thorough answer** ranks up to 150 sections, packs them into request-sized batches, asks each
  batch for cited notes, and combines the notes in one last request. A batch whose reply is empty
  twice is named in the answer as not read. It runs as a job beside batched reviews, one per chat.
- **Search by meaning** is set apart from the chat provider: the chat provider when it embeds, the
  Gemini or OpenAI API with its own key, or off.
- **Telemetry** is kept in `<data dir>/telemetry/` for 14 days, up to 200 MB. It records counts, ids,
  durations, allowed page titles and error messages, never page text, prompts, answers, credentials
  or the title of an excluded page.
- **Problems are flagged** without setup: the server frozen for over a second, a failed context
  check, most AI requests failing, or an index run with failures.

## Alternatives considered

- **A copy of Datadog's features**, with dashboards, alert rules and saved views. Declined: the page
  answers whether the app is stuck, what was sent, where the time went and what failed, and nothing
  more is needed yet.
- **A local embedding model.** Declined for now: it would add a large runtime dependency (ADR-021).
- **Expanding a question with the space's topics.** Declined (ADR-056): topics already count in the search,
  and their words are stemmed like the question's, so a match on a topic word is found already. What
  expansion would add, words that mean the same, needs embeddings, which the separate embedding
  provider gives.

## Testing

A generated 3,200-page space is indexed and asked about. The fast suite fails if indexing it takes
more than 640 requests or leaves a page out, and the scale check, `pnpm run test:scale`, fails if a
health check waits 250 ms while it runs; the scale check runs on a real machine, not in CI (ADR-057). Route
tests check that every item the manifest includes is in what was sent, that a stand-in Gemini CLI
receives every byte, that no telemetry file holds page text or an excluded title, and that retrieval
finds the expected pages for a fixed set of questions.

## Open questions

- Real Gemini CLI timings and rate limits, to be measured on the real space.
