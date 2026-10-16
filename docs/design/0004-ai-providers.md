# 0004 — Asking an AI: one engine, an outbound guard, and conversations on the server

**Status:** Planned
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-15

## Problem

The north star's three jobs all run through a model, and every one of them sends Confluence content
off the machine. Which content, to whom, and with what removed must have one answer.

## Decision

The design settled in ADR-017, ADR-018, ADR-022 and ADR-023 carries over unchanged; this document
records how it sits in the package.

- `src/ai/engine.ts` is the only caller of a provider, and runs the guard on every request.
- `src/ai/providers.ts` is the only module that loads an AI SDK, and accepts only a
  `GuardedPayload`, which only `src/ai/guard.ts` can build.
- `src/ai/geminiService.ts` runs the Gemini CLI as `node <bundle>` with the prompt on stdin, the one
  process the app starts.

## Behavior

| route                                     | what                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| `GET`/`PUT /api/ai/settings`              | provider, model, endpoint; keys are write-only           |
| `GET /api/ai/models/:provider`            | models the saved key can use                             |
| `POST /api/ai/test`, `GET /api/ai/status` | a test call; whether an AI is configured                 |
| `POST /api/ai/analyze`                    | one question about a page, with or without its sub-pages |
| `POST /api/space-cache/:spaceKey/ai/ask`  | one question about a space                               |
| `/api/ai/sessions/...`                    | conversations, their messages and uploaded files         |

- A page that is excluded, or whose exclusion cannot be checked, is refused before the engine is
  called (`gatePageForAi`, ADR-018).
- Secrets stop a request; personal data is replaced with numbered placeholders; the response says
  what was removed, never the value (ADR-022).
- Uploads are context only, extracted to text, and pass the same guard (ADR-023).

## Alternatives considered

None new; each was weighed in the records above.

## Implementation plan

Lands as its own pull request after the Confluence move, so the gate has the library-backed
exclusion check to call.

## Testing

The current tests carry over by name: the guard's detector corpus (a new detector fails until its
cases are added), the session store, the engine's audit line, and the end-to-end refusal of an
excluded page on every AI route. Calls against real provider keys stay the maintainer's check and
are labelled unverified until made.

## Open questions

- A shared server, where anyone who can open Settings can change the provider (ADR-017, open).
