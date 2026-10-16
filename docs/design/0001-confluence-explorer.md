# 0001 — Confluence Explorer: what it does and how the package is built

**Status:** Planned
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-15

## Problem

A team that keeps its documentation in Confluence Server or Data Center has no quick way to ask a
model what a space says, to have a page improved under review, or to find pages that contradict or
repeat each other ([north star](../north-star.md)). The app that does this exists outside this
repository as npm workspaces with an Express server and a React client; this document is how it
takes this repository's shape (ADR-027).

## Decision

One package. `src/` is the `node:http` server and owns every call to Confluence and to an AI
provider; `web/` is the Svelte 5 frontend; `bin/run.js` starts both as `confluence-explorer`. The
types both halves need are one module, `src/api/types.ts`, which `web/` imports with `import type`
only, so no server code reaches the bundle.

## Behavior

What a person can do, each covered by its own design doc where it reaches beyond browsing:

| job               | in the app                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Connect           | Settings: Confluence URL and personal access token, kept on the server (ADR-019, 0003)         |
| Browse            | Space switcher, page tree, jump to a URL or id; a page reads as rendered, Markdown or storage  |
| Keep a local copy | Sync a space to disk; AI summaries and a table of contents; download a space as a ZIP          |
| Keep pages away   | `.confluenceignore` per space; excluded pages never reach a model (ADR-018)                    |
| Ask               | Ask AI about a page, a page and its sub-pages, or a space, in a conversation (0004)            |
| Improve           | A proposed revision as a diff, dry-run, then a push the person confirms (0005)                 |
| Review a branch   | A page and everything under it reviewed or improved into a queue, accepted page by page (0005) |
| Write a new page  | Only after a check for pages that already say it (ADR-025, 0005)                               |

The page layout is ADR-026's: header (connection, New page, Snippet parser, Settings, theme); a
sidebar with the space switcher, the Space menu and the tree; four page tabs, Read, Ask AI, Improve
and Details.

`/api` routes keep their current paths, with one rename: the improve, dry-run and push routes move
from `/api/simply/pages/:pageId/*` to `/api/pages/:pageId/*`, since no separate tool is involved
any more (ADR-028). Every route answers this machine only (ADR-018), validates `:spaceKey` and
`:pageId` before use, and returns JSON errors without stack traces.

| prefix             | what                                                             |
| ------------------ | ---------------------------------------------------------------- |
| `/api/health`      | the template's health route                                      |
| `/api/connection`  | read and save the connection; the token is write-only            |
| `/api/spaces`      | live spaces, a space's pages, resolve a URL to a page            |
| `/api/pages`       | a page; improve, dry-run and push                                |
| `/api/space-cache` | sync, TOC, metadata, ZIP, exclusions, guard rules, purge         |
| `/api/ai`          | settings, models, status, one-shot analysis; `sessions` for chat |
| `/api/branches`    | branch runs and their review queue                               |
| `/api/drafts`      | new-page drafts                                                  |

## Alternatives considered

- **Keep three workspaces** (`shared`, `server`, `client`). Declined: the template is one package
  with two halves, and a shared workspace for one types file is a package to version for nothing.
- **Keep React.** Declined in ADR-027.

## Implementation plan

The staged pull requests, each green on its own:

1. These design docs, the decision log and `AGENTS.md`.
2. Guardrails: budgets and docs-convention tests in Vitest, `.agent-standard`.
3. Server foundation: the router, Host and Origin checks, parameter guards, the data directory
   (0003), the connection store, the doctor.
4. Confluence through simply-atlassian-core (0002): browse, sync, exclusions, metadata, ZIP.
5. AI (0004).
6. Writes to Confluence (0005).
7. The Svelte UI.
8. The end-to-end CI job (0006) and the budgets re-measured on the new layout.

## Testing

The existing suite moves with its code and keeps its test names, run under Vitest. Each pull
request is green on `pnpm run build` and `pnpm test` on Linux and Windows, and from step 4 on the
end-to-end suite against a real Data Center. The UI is walked in a browser in both themes.

## Open questions

- Release automation, which `CONTRIBUTING.md` leaves until the app has features. The repository
  owner decides when.
