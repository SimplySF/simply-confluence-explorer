# 0002 — Runtime dependencies: simply-atlassian-core and `node:http` instead of fifteen packages

**Status:** Planned
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-15

## Problem

The server has no runtime dependencies, and adding one needs discussion. The app it is replacing
has fifteen. Each is review surface in a program that holds a Confluence token and sends pages to
third parties.

## Decision

Confluence goes through `@simplysf/simply-atlassian-core` (ADR-028), HTTP is `node:http`, and seven
runtime dependencies remain, each named below with its reason. The frontend's packages are
devDependencies, because only the built bundle ships.

## Behavior

| removed                              | replaced by                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `axios`                              | the library's `ConfluenceClient` and `HttpTransport` (retry on 429 and 5xx)          |
| `@simplysf/simply-atlassian`, `-cli` | the library's page-update and page-create functions, in process                      |
| `turndown`, `turndown-plugin-gfm`    | the library's `storageToMarkdown`, also for uploaded `.html` files                   |
| `cheerio`                            | the library's converter; kept only if the fixture test shows a macro it cannot read  |
| `express`                            | `node:http` and a small router with validated parameters (`src/http/router.ts`)      |
| `helmet`                             | the headers it set, written by the router: CSP, `nosniff`, frame and referrer policy |
| `dotenv`                             | the library's `loadEnvFile`, read once in `main()` into the injected `env`           |

| kept                  | why                                                                         |
| --------------------- | --------------------------------------------------------------------------- |
| simply-atlassian-core | Confluence access; no dependencies of its own                               |
| `@anthropic-ai/sdk`   | Claude (ADR-017); confined to `ai/providers.ts`                             |
| `openai`              | ChatGPT (ADR-017); confined to `ai/providers.ts`                            |
| `@google/genai`       | the Gemini API (ADR-017); confined to `ai/providers.ts`                     |
| `archiver`            | the space ZIP; a correct streaming ZIP writer is not small                  |
| `yaml`                | page frontmatter written to and read from disk                              |
| `unpdf`               | text from uploaded PDFs for providers that cannot take a document (ADR-023) |

Frontend devDependencies added to the template's: `@lucide/svelte` (icons) and `marked` (rendering
Markdown in Read and in previews).

## Alternatives considered

- **No runtime dependencies at all**: call the three AI APIs with `fetch` and write the ZIP by
  hand. Declined: the maintainer chose each provider's own SDK (ADR-017), and the hand-written
  versions would be more code to review than the packages they replace.
- **Keep the current set and argue for each.** Declined: the library already does what five of them
  do, and the template asks for it.

## Implementation plan

Each removal lands in the pull request that moves the code using it: `express`, `helmet` and
`dotenv` with the server foundation; `axios`, `cheerio`, `turndown` and the push tool with the move
to the library. The dependency budget (ADR-014) is re-measured on the new manifest by ADR-030.

## Testing

- A fixture test converts every page in the test dataset with the old converter and the library's,
  and records the differences. That pull request lists them; none is accepted without saying so.
- The router's tests carry over the current security suite: parameter validation, Host and Origin
  checks, no stack traces in errors, and the security headers.
- The budgets keep the architecture rows: one module imports the library's clients, one loads the
  AI SDKs, one starts a process.

## Open questions

- Whether the library's converter reads every macro the current one handles. The fixture test
  answers it.
