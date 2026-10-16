# 0002 — Runtime dependencies: simply-atlassian-core and `node:http` instead of fifteen packages

**Status:** Implemented (PR #7)
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-15

## Problem

The template's server has no runtime dependencies, and `AGENTS.md` says that adding one needs
discussion first. The app being moved here has fifteen. Every one of them is code that someone has
to review and keep up to date, and this app holds a Confluence token and sends page content to
third-party AI providers. Each package it depends on is a place where that token or that content
could be mishandled, so the list should be as short as it can reasonably be.

## Decision

- Confluence is reached through `@simplysf/simply-atlassian-core` (ADR-028).
- HTTP serving uses Node's built-in `node:http` module.
- Seven runtime dependencies remain. Each is listed below with the reason it stays.
- The frontend's packages become devDependencies. Only the built bundle ships, so nothing the
  frontend uses at build time is installed for the person running the app.

## Behavior

These packages are removed, and this is what takes over their work:

| removed                              | what replaces it                                                                                                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `axios`                              | The library's `ConfluenceClient` and `HttpTransport`. The transport retries requests that fail with a 429 or a 5xx response.                                                                                                                 |
| `@simplysf/simply-atlassian`, `-cli` | The library's page-update and page-create functions, called directly in the server process instead of by starting a separate program.                                                                                                        |
| `turndown`, `turndown-plugin-gfm`    | The library's `storageToMarkdown`, which also converts uploaded `.html` files to Markdown.                                                                                                                                                   |
| `cheerio`                            | The library's converter. The comparison over the test dataset found no macro that needed `cheerio` back; ADR-033 records the five things the library lost at first; core 0.7.2 keeps all five, and `test/converter.test.ts` checks each one. |
| `express`                            | `node:http`, with a small router that validates route parameters (`src/http/router.ts`).                                                                                                                                                     |
| `helmet`                             | The router sets the same security headers itself: a content security policy, `nosniff`, and frame and referrer policies.                                                                                                                     |
| `dotenv`                             | The library's `loadEnvFile`. It is read once in `main()`, and the values are passed down as the injected `env` rather than read from the process.                                                                                            |

These seven stay:

| kept                  | why it stays                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| simply-atlassian-core | All Confluence access goes through it. It has no runtime dependencies of its own.                               |
| `@anthropic-ai/sdk`   | Talks to Claude (ADR-017). Only `ai/providers.ts` may import it.                                                |
| `openai`              | Talks to ChatGPT (ADR-017). Only `ai/providers.ts` may import it.                                               |
| `@google/genai`       | Talks to the Gemini API (ADR-017). Only `ai/providers.ts` may import it.                                        |
| `archiver`            | Builds the ZIP download of a space. Writing a correct streaming ZIP by hand would take more code than it saves. |
| `yaml`                | Reads and writes the frontmatter at the top of each page saved to disk.                                         |
| `unpdf`               | Extracts the text from uploaded PDFs, for AI providers that cannot accept a PDF document directly (ADR-023).    |

Two devDependencies are added to the template's set for the frontend: `@lucide/svelte` for icons,
and `marked`, which renders Markdown in the Read tab and in previews.

## Alternatives considered

- **No runtime dependencies at all.** That would mean calling the three AI APIs with `fetch` and
  writing the ZIP file by hand. Declined. The maintainer chose to use each provider's official SDK
  (ADR-017), and hand-written replacements would be more code to review than the packages they
  replace.
- **Keep the current fifteen and argue for each one.** Declined. The library already does what five
  of them do, and the template asks for the library to be used.

## Implementation plan

Each package is removed in the pull request that moves the code using it:

- `express`, `helmet` and `dotenv` go with the server foundation.
- `axios`, `cheerio`, `turndown` and the push tool go with the move to the library.

The dependency budget (ADR-014) is measured again against the new manifest. The new numbers are
recorded in ADR-031.

## Testing

- **The converter.** A fixture test converts every page in the test dataset twice, once with the
  current converter and once with the library's, and records where the two disagree. The pull
  request that makes the switch lists every difference, so none of them is accepted without being
  stated.
- **The router.** Its tests carry over the current security suite: route parameter validation, the
  Host and Origin checks, error responses without stack traces, and the security headers.
- **The architecture.** The budgets keep their architecture rows, which check that exactly one
  module imports the library's clients, exactly one loads the AI SDKs, and exactly one starts an
  external process.

## Open questions

- Whether the library's converter reads every Confluence macro that the current converter handles.
  The fixture test will answer this before the switch is made.
