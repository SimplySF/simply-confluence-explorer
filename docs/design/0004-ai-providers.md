# 0004 — Asking an AI: one engine, an outbound guard, and conversations on the server

**Status:** Planned
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-15

## Problem

All three of the north star's jobs depend on a language model, and every one of them sends
Confluence content off the machine to an AI provider. Anyone reviewing the app needs to be able to
answer three questions with confidence: which content is sent, which provider it is sent to, and
what is removed from it first. Each of those questions should have one answer, found in one place in
the code.

## Decision

The AI design was settled in ADR-017, ADR-018, ADR-022 and ADR-023, and it carries over unchanged.
This document describes where each part of it sits in the new package.

- **One engine.** `src/ai/engine.ts` is the only code that calls an AI provider. It runs the
  outbound guard on every request before anything is sent.
- **The outbound guard.** `src/ai/guard.ts` inspects everything about to leave the machine. It stops
  the request if it finds a secret, and replaces personal data with placeholders. It is the only
  code that can build a `GuardedPayload`, the type that represents content the guard has checked.
- **One module for the SDKs.** `src/ai/providers.ts` is the only module that loads an AI provider's
  SDK, and it accepts only a `GuardedPayload`. Because only the guard can build that type, the
  compiler rejects any attempt to send content that has not been through the guard.
- **One external process.** `src/ai/geminiService.ts` runs the Gemini CLI as `node <bundle>`, with
  the prompt passed on standard input rather than on the command line, so the prompt does not
  appear in the system's process list. This is the only external program the app starts.

## Behavior

| route                                     | what it does                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET`/`PUT /api/ai/settings`              | Reads and saves the AI provider, model and endpoint. Keys can be saved but are never returned. |
| `GET /api/ai/models/:provider`            | Lists the models that the saved key is allowed to use.                                         |
| `POST /api/ai/test`, `GET /api/ai/status` | Makes a test call to the provider, and reports whether an AI is configured at all.             |
| `POST /api/ai/analyze`                    | Answers one question about a page, with or without its sub-pages.                              |
| `POST /api/space-cache/:spaceKey/ai/ask`  | Answers one question about a whole space.                                                      |
| `/api/ai/sessions/...`                    | Conversations: creating them, sending messages, and uploading files to them.                   |

- **Excluded pages are refused.** Before the engine is called, `gatePageForAi` checks whether the
  page is excluded. If it is, or if the check cannot be completed, the request is refused (ADR-018).
  Failing closed in this way means an error in the check can never let an excluded page through.
- **Secrets and personal data are handled before sending.** A secret, such as a private key or an
  API token, stops the request. Personal data, such as an email address or a phone number, is
  replaced with a numbered placeholder. The response tells the person what was removed, but never
  repeats the value itself (ADR-022).
- **Uploads are context only.** An uploaded file is extracted to text, used as context for the
  conversation, and passed through the same guard as everything else (ADR-023).

## Alternatives considered

None beyond those already weighed in the records listed under Decision.

## Implementation plan

This lands as its own pull request, after Confluence access has moved to the library. The order
matters: the exclusion check that the engine calls is built on the library, so it has to exist
first.

## Testing

The current tests carry over under their existing names:

- the guard's detector corpus, a set of example secrets and personal data that each detector must
  catch. A new detector fails its test until its examples are added to the corpus;
- the session store;
- the line the engine writes to the audit log for each request;
- the end-to-end tests that check an excluded page is refused on every AI route.

Calls against real provider keys remain the maintainer's check. Until the maintainer has made them,
they are labelled as unverified.

## Open questions

- How a shared server should work. On a shared server, anyone who can open Settings can change the
  AI provider for everyone using it. This is still open in ADR-017.
