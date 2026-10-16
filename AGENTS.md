# AGENTS.md

## Documentation map

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the pull-request checklist, then the
package's own `CONTRIBUTING.md` for what is specific to it. New features start as a design doc in
[docs/design/](docs/design/README.md).

## Working conventions

- `@simplysf/simply-confluence-explorer` is two halves in one package: a Node server in `src/`
  (compiled by `tsc` to `lib/`) and a Svelte frontend in `web/` (bundled by Vite to `dist/web/`). The
  server serves the bundle and owns every call to Atlassian; the browser only ever talks to the
  server's `/api/*` routes, so credentials never reach the page.
- Prefer `@simplysf/simply-atlassian-core` for Confluence access over a second client. Adding any
  runtime dependency needs discussion first.
- The server binds to `127.0.0.1` by default. Listening on another interface is an explicit opt-in.
- Read `process.env` only through an injectable `env` option, and give anything that writes output an
  injectable sink, so tests never need stubbed globals.
- Commits follow Conventional Commits; commitlint enforces it and Lerna versions from it.

Every session, also read [docs/north-star.md](docs/north-star.md) and the record titles in
[docs/decisions.md](docs/decisions.md). A design doc says what a feature is; the decision log holds
the rules, the budgets, exceptions to a fence, and every refusal (ADR-027). A decision already
declined is settled, and a proposal to revisit it is answered with the record's number rather than a
fresh argument. The north star is the maintainer's: an agent proposes changes to it, it does not
make them.

## The standard this project is held to

The project is held to the agent-led development standard, version 1, at **stakes `real`**
(ADR-001): a team depends on it, and it can change shared Confluence pages. `.agent-standard` is the
declaration. The standard's conformance check is kept outside this repository; `pnpm run standard`
runs it when it sits beside the checkout and says it was skipped otherwise.

### The decision log

`docs/decisions.md` is numbered and append-only. A record is superseded or amended by a later
record, never edited away and never deleted.

- A title is a sentence stating the decision, never a topic.
- Every record carries a `**Status:**` line.
- **Refusals are recorded as well as choices.** A title that refuses says so plainly (`not`, `no`,
  `never`, `instead of`, `declined`, `deferred`).
- A decision made in conversation is not made until it is in the log or in a design doc.
- Adding or removing a dependency, changing a budget, or making an exception to a fence needs a
  record, and the commit cites its number. A version bump within the existing set does not.

### Comments record intent, never history

A comment answers "why is this code shaped this way". It does not record what the code used to be;
git and the decision log hold history. The test: **would this comment still make sense to someone
who had never seen the previous version?** The same test governs user-facing prose, whose one
reader is someone arriving for the first time. Each document keeps its existing voice; the standard
governs what it claims, not how it sounds.

- A bug fix ships with a test, and the test name carries the story. A fixed setup failure ships
  with a doctor check instead (ADR-016).
- A 30-line function does not need 40 lines of preamble. If the reasoning is that long, it is a
  design doc or a record.
- No self-narration. Comments describe the code, not the process that produced it.
- Prefer deleting a comment to writing one that restates the line below it.

### Checks

- `pnpm run build` then `pnpm test` before every commit. The budgets (ADR-014) are part of
  `pnpm test`. Do not argue with a budget; write a record to change it.
- `pnpm test` is the fast suite and **excludes** the end-to-end suite. `pnpm run test:e2e` runs
  against the Confluence test environment (`pnpm run testenv:start`) and skips without it. "All
  tests pass" names which suite ran.
- Every user-facing claim names the test or CI job that proves it, or the claim goes.
- A new result in a closed-world set goes in the expectation table: `expectations` in
  `test-env/fixtures/dataset.mjs` for exclusions. The test failure will say so.
- Where the same fact is stated twice, once authored and once generated, a test holds the two
  together.

### Load-bearing surfaces

Every change here is flagged in the pull request description and gets human review. At stakes
`real`, a second person answers the review packet (`docs/review/`) for these independently before
release. Paths are under `packages/simply-confluence-explorer/src/`.

| surface                         | where                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Writes to Confluence            | `confluence/pagePush.ts`, the one write path; `branches/branchRuns.ts` (ADR-024); `drafts/drafts.ts` |
| HTTP to Confluence              | `confluence/client.ts`, the only module that imports simply-atlassian-core's clients (ADR-028)       |
| Tokens                          | `confluence/connection.ts` (the Confluence token), `util/privateFile.ts`                             |
| Pages sent to AI providers      | `ai/providers.ts`, the only module that loads their SDKs (ADR-017)                                   |
| The outbound guard              | `ai/guard.ts` and the engine that runs it, `ai/engine.ts` (ADR-022)                                  |
| AI conversations and uploads    | `ai/sessions.ts` and its routes (ADR-023)                                                            |
| AI keys                         | `ai/settings.ts`                                                                                     |
| External processes              | `ai/geminiService.ts`                                                                                |
| Deletes files                   | `spaces/spaceSyncManager.ts` (purge)                                                                 |
| Paths built from request values | `http/guards.ts` (validation), `within()` in `util/paths.ts`                                         |
| Sensitive-data exclusion        | `spaces/exclusionManager.ts` and every caller of `isPageExcluded`                                    |
| The enforcement itself          | `package.json` scripts and Wireit config, `.github/workflows/`, `test-env/`, `test/budgets.test.ts`  |

### The rules specific to this program

- **The server holds the connection.** A request never names its own Confluence, and no token is
  ever returned to a browser (ADR-019).
- **An excluded page never leaves the machine.** Every path that sends page content to an AI goes
  through `gatePageForAi`, which fails closed (ADR-018).
- **Nothing reaches an AI unguarded.** Providers take only a `GuardedPayload`; a new detector goes in
  the corpus in the guard's test, which fails until it does (ADR-022).
- **The server answers this machine only.** Host and Origin are checked; sharing is an explicit
  `--host` plus an allow-list, never a widened default (ADR-018).
- **A push names the version it was made from**, and a mismatch is refused.
- **The test dataset is the source of truth** for the test environment's spaces and
  `.confluenceignore` files; generated copies are overwritten on every seed (ADR-007).

### Instinct fences

Each is a failure that has actually shipped in agent-led work, so the instinct is named before it
fires.

- **Answer the ask.** Extra scope is proposed in prose, never shipped in the diff.
- **Fix in place.** No `_v2`/`_new`/`_old` parallel files; a replacement and the deletion it replaces
  travel in one commit.
- **Never discard an error** without a comment saying why ignoring it is correct.
- **Never weaken or delete a test to go green.** A known defect is a `todo` test, not a deleted one.
- **Never claim something ran** without the command and its output. Anything unverified is labelled
  unverified.
- **Test the code, not the machine.** A test that asks whether something is installed passes where it
  was written and fails where the artifact is built.
- **Done is the consumed artefact.** A green workflow is a step; the packed app used against
  Confluence is finished.
- **No local detail leaves the machine.** This repository is public. Absolute paths, hostnames,
  account names, real space keys and real page content never reach a commit, an issue, a comment or
  a document. Use the test dataset's generic cast.
- **No placeholders** without a named tracking issue. The TODO count is declared in
  `.agent-standard`, and it is zero.
- **One diff, one intent.** Refactors and fixes ship separately.
- **Security is not traded for convenience.** TLS verification off, broad permissions, inline secrets
  and string-built shell commands need a record.
- **Give the strongest counter-argument first** on any proposal, and build only what survives it.
- **Polish is not proof.** Only executed checks count.
- **A standard without a gate is a wish.** Adding one means adding the command that disagrees with
  it, in the same commit.
- **Open the pull request when the work is done** and the checks are green, not before. Do not keep
  pushing to a pull request under review.

### Not yet armed

Each line is a gate this file names that nothing in this repository enforces yet. It is retired from
this list in the commit that adds its command.

- The budgets and docs-convention tests (`test/budgets.test.ts`).
- `pnpm run standard` and `.agent-standard`.
- `pnpm run test:e2e`, `pnpm run testenv:start`, `test-env/`, and the end-to-end CI job.
- The doctor (`confluence-explorer doctor`).
