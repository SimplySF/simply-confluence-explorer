# 0003 — Where the app keeps its data, and the token with it

**Status:** Planned
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-15

## Problem

The app writes synced spaces, AI conversations, review queues, the Confluence token and AI keys.
Today it writes them under the directory it was started from. Run through `npx`, that directory is
wherever the person happened to be, and the token would follow them around.

## Decision

One data directory per user, `~/.confluence-explorer` by default, holds everything the app writes.
`--data-dir <path>` or `CONFLUENCE_EXPLORER_DATA` moves it, the flag winning as for `--port`.
`main()` resolves it once and passes it down; no module computes its own path.

## Behavior

| path inside it            | holds                                                        |
| ------------------------- | ------------------------------------------------------------ |
| `config/connection.json`  | Confluence URL, token, self-signed choice (ADR-019)          |
| `config/ai-settings.json` | AI provider and keys (ADR-017)                               |
| `spaces/<KEY>/`           | synced pages, `.confluenceignore`, `.confluenceguard`, TOC   |
| `data/sessions/`          | AI conversations and uploads (ADR-023)                       |
| `data/branch-runs/`       | review queues (ADR-024)                                      |
| `data/ai-audit.jsonl`     | what was sent to which provider, never the content (ADR-022) |

- Files holding a token or a key are written atomically with mode `0600`. On Windows, where that
  mode means nothing, the doctor says the file is protected only by the user's profile permissions.
- `CONFLUENCE_URL` and `CONFLUENCE_TOKEN` in the environment, or a `.env` file in the data
  directory, are fallbacks; a value saved in Settings wins, as today.
- Every path built from a request value goes through `within()`, so a space key cannot reach outside
  `spaces/`.

## Alternatives considered

- **The working directory**, as today. Declined for the reason above.
- **Platform conventions** (`%APPDATA%`, `~/Library/Application Support`, `$XDG_DATA_HOME`). More
  correct, and three code paths to test for one app. A single dot-directory is what most Node CLIs
  do and the flag covers the rest.

## Implementation plan

Lands with the server foundation: `src/util/dataDir.ts` resolves it, and every store takes its
directory as a constructor argument.

## Testing

- Every test passes a temporary data directory, so the suite never writes into a real one.
- The flag beats the environment variable, which beats the default.
- A space key of `..` or `%2E%2E` is refused before any path is built.
- Token and key files are created `0600` (POSIX only; the test says so on Windows).

## Open questions

- None.
