# 0001 — Confluence Explorer: what it does and how the package is built

**Status:** Planned
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-15

## Problem

Teams that keep their documentation in Confluence Server or Data Center have no quick way to put a
language model to work on it. They cannot easily ask a model what a space says and get an answer
that points back to the page it came from. They cannot have a page improved and review the change
before it is published. They cannot find the pages that contradict or repeat each other. These are
the three jobs described in the [north star](../north-star.md).

An app that does these things already exists outside this repository. It is built as three npm
workspaces, with an Express server and a React client. This document describes how that app is
reshaped to fit this repository's structure. The decision to adopt the structure is recorded in
ADR-027.

## Decision

The app becomes a single package with two halves:

- `src/` is the server, built on `node:http`. It makes every call to Confluence and to an AI
  provider, so that credentials and API keys stay on the server and never reach the browser.
- `web/` is the frontend, written in Svelte 5.
- `bin/run.js` starts the app as the `confluence-explorer` command.

The request and response types that both halves need are defined once, in `src/api/types.ts`. The
frontend imports that module with `import type` only. Type-only imports are removed when the
frontend is compiled, so no server code can end up in the bundle that ships to the browser.

## Behavior

The table below lists what a person can do in the app. Where a feature goes beyond browsing, it has
its own design doc, named in the last column.

| job                     | what the person does in the app                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect to Confluence   | Enter the Confluence URL and a personal access token in Settings. The token is kept on the server and never sent back to the browser (ADR-019, 0003).                                               |
| Browse                  | Switch between spaces, move through the page tree, or jump straight to a page by its URL or id. A page can be read as rendered content, as Markdown, or as Confluence's storage format.             |
| Keep a local copy       | Sync a space to disk. Once synced, the app can generate AI summaries and a table of contents for the space, and download the whole space as a ZIP.                                                  |
| Keep pages away from AI | List pages in a space's `.confluenceignore` file. An excluded page is never sent to a model (ADR-018).                                                                                              |
| Ask questions           | Ask an AI about one page, about a page together with its sub-pages, or about a whole space, in a conversation that remembers earlier turns (0004).                                                  |
| Improve a page          | Get a proposed revision shown as a diff against the current page, check it with a dry run, and then publish it only after confirming (0005).                                                        |
| Review a branch         | A branch is a page plus everything under it. The app reviews or improves every page in the branch and puts the results in a queue, where a person accepts or rejects each page individually (0005). |
| Write a new page        | Draft a new page with the AI. The app first checks whether existing pages already cover the topic, and the page is created only after the author has answered that check (ADR-025, 0005).           |

The page layout is the one settled in ADR-026:

- The **header** holds the connection status, New page, Snippet parser, Settings, and the theme
  switch.
- The **sidebar** holds the space switcher, the Space menu, and the page tree.
- A page has four **tabs**: Read, Ask AI, Improve, and Details.

The `/api` routes keep the paths they have today, with one rename. The improve, dry-run and push
routes move from `/api/simply/pages/:pageId/*` to `/api/pages/:pageId/*`. The old prefix named the
separate push tool those routes used to call; the tool is no longer involved, so the name no longer
fits (ADR-028).

Three rules apply to every route:

- It answers requests from this machine only (ADR-018).
- It validates `:spaceKey` and `:pageId` before using them, so a malformed value is refused before
  it can be used to build a file path or a Confluence request.
- It returns errors as JSON without stack traces, so internal details are not exposed.

| prefix             | what the routes under it do                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `/api/health`      | Reports that the server is up and which version it is running. This route comes from the template.                  |
| `/api/connection`  | Reads and saves the Confluence connection. The token can be written but is never returned.                          |
| `/api/spaces`      | Lists the spaces in Confluence, lists the pages in a space, and resolves a Confluence URL to the page it points at. |
| `/api/pages`       | Reads a page, and proposes, dry-runs and pushes improvements to it.                                                 |
| `/api/space-cache` | Works with synced spaces: sync, table of contents, metadata, ZIP download, exclusions, guard rules, and purge.      |
| `/api/ai`          | AI settings, the models a key can use, AI status, and one-off questions. Conversations live under `sessions`.       |
| `/api/branches`    | Branch runs and their review queues.                                                                                |
| `/api/drafts`      | Drafts of new pages.                                                                                                |

## Alternatives considered

- **Keep the three workspaces** (`shared`, `server` and `client`). Declined. The template is one
  package with two halves, and a separate `shared` workspace would hold a single file of types. That
  is a whole package to version and publish for no benefit.
- **Keep React** instead of moving to Svelte. Declined in ADR-027.

## Implementation plan

The work arrives as a series of pull requests. Each one builds and passes its tests on its own, so
any of them can be reviewed, merged or reverted without the others.

1. These design docs, the decision log, and `AGENTS.md`.
2. Guardrails: the size and architecture budgets and the documentation tests, run by Vitest, and the
   `.agent-standard` declaration.
3. The server foundation: the router, the Host and Origin checks, route parameter validation, the
   data directory (0003), the connection store, and the doctor command.
4. Confluence access through simply-atlassian-core (0002): browsing, sync, exclusions, metadata, and
   the ZIP download.
5. AI (0004).
6. Writes to Confluence (0005).
7. The Svelte UI.
8. The end-to-end CI job (0006), and the budgets measured again on the finished layout.

## Testing

The existing test suite moves with the code it tests. Each test keeps its name and runs under
Vitest. Every pull request passes `pnpm run build` and `pnpm test` on both Linux and Windows. From
step 4 onwards, each one also passes the end-to-end suite against a real Confluence Data Center.
The UI is checked by walking through it in a browser, in both the light and the dark theme.

## Open questions

- When to set up release automation. `CONTRIBUTING.md` defers it until the app has real features.
  The maintainer decides when that point has been reached.
