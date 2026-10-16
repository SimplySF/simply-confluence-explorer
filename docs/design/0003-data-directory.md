# 0003 — Where the app keeps its data, and the token with it

**Status:** Implemented (PR #3)
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-15

## Problem

The app writes several kinds of data to disk: synced spaces, AI conversations, branch review
queues, the Confluence token, and AI provider keys. Today it writes all of them under the directory
it was started from.

That works when the app is run from a fixed checkout, but this package is meant to be run with
`npx`. With `npx`, the starting directory is wherever the person happened to be in their terminal.
Their synced spaces would be scattered across whichever folders they ran it from, and so would the
file holding their Confluence token.

## Decision

Each user has one data directory that holds everything the app writes. By default it is
`~/.confluence-explorer`. The `--data-dir <path>` flag or the `CONFLUENCE_EXPLORER_DATA` environment
variable moves it elsewhere. If both are given, the flag wins, in the same way `--port` wins over
`PORT`.

`main()` works out the data directory once at startup and passes it to every part of the app that
needs it. No module computes its own path, so there is only one place to look when asking where
something is stored.

## Behavior

These are the paths inside the data directory:

| path                      | what it holds                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `config/connection.json`  | The Confluence URL, the token, and whether to accept a self-signed certificate (ADR-019).                  |
| `config/ai-settings.json` | The chosen AI provider and its keys (ADR-017).                                                             |
| `spaces/<KEY>/`           | One space's synced pages, its `.confluenceignore` and `.confluenceguard` rules, and its table of contents. |
| `data/sessions/`          | AI conversations and the files uploaded to them (ADR-023).                                                 |
| `data/branch-runs/`       | Branch review queues (ADR-024).                                                                            |
| `data/ai-audit.jsonl`     | A record of what was sent to which AI provider and when. It never contains the content itself (ADR-022).   |

- **Secrets are protected on disk.** Files holding a token or a key are written atomically, so a
  crash can never leave half a file, and with mode `0600`, so only the owning user can read them.
  Windows does not honour that mode. There, the doctor tells the person that the file is protected
  only by the permissions on their user profile.
- **The environment can set the connection instead of Settings.** When `CONFLUENCE_URL` is set,
  the app uses it with `CONFLUENCE_PERSONAL_TOKEN`, and Settings shows the connection as fixed by the
  environment and cannot change it (ADR-019). These are the variable names simply-atlassian-core
  uses, so one `.env` file serves this app and the `simply` command alike.
- **A `.env` file in the data directory is read at startup.** It fills in only the Atlassian
  connection variables, and only where the real environment has not already set them. Reading
  nothing else from it means a stray `.env` file cannot change how the app runs in any other way,
  such as turning off certificate checks.
- **An internal certificate authority is trusted, never bypassed.** Certificates are always
  verified (ADR-032). A Confluence whose certificate comes from a company's own certificate
  authority is reached by starting the app with `NODE_EXTRA_CA_CERTS` pointing at that authority's
  certificate file. The doctor names the file when it is set.
- **Request values cannot escape the directory.** Every path built from a value in a request goes
  through `within()`, which refuses any result that lands outside its base directory. A space key
  therefore cannot be used to read or write anything outside `spaces/`.

## Alternatives considered

- **The working directory, as today.** Declined, for the reason given under Problem.
- **Each platform's own convention**: `%APPDATA%` on Windows, `~/Library/Application Support` on
  macOS, and `$XDG_DATA_HOME` on Linux. This is more correct, but it means three code paths to write
  and test for one app. A single dot-directory in the home folder is what most Node command-line
  tools use, and anyone who wants it elsewhere can use the flag.

## Implementation plan

`src/util/dataDir.ts` resolves the directory, and `main()` in `src/cli.ts` passes it to
`createServer`, which hands it to every store. The `.env` file is read in `main()` with the
library's `loadEnvFile`, into a copy of the environment that the rest of the app receives.

## Testing

- Every test passes in a temporary data directory, so running the suite never writes into a real
  one.
- The flag takes priority over the environment variable, and the environment variable takes
  priority over the default.
- A space key of `..` or `%2E%2E` is refused before any path is built from it.
- Token and key files are created with mode `0600`. This is checked on POSIX systems only, and on
  Windows the test reports that it was not checked.

## Open questions

- None.
