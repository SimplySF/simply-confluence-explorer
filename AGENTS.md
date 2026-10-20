# AGENTS.md

## Documentation map

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the pull-request checklist, then the
package's own `CONTRIBUTING.md` for what is specific to it. New features start as a design doc in
[docs/design/](docs/design/README.md).

At the start of every session, also read [docs/north-star.md](docs/north-star.md), which states
what the app is for, and the record titles in [docs/decisions.md](docs/decisions.md). The two kinds
of record have different jobs (ADR-027). A design doc describes one feature: what it does and how it
behaves. The decision log holds everything that is not a single feature: the project's rules, its
budgets, any exception to a fence, and every proposal that was refused. When something has already
been declined, it is settled. If it comes up again, answer it by citing the record's number instead
of arguing it a second time. The north star belongs to the maintainer, so an agent may propose a
change to it but must not make one.

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

## The standard this project is held to

This project follows the agent-led development standard, version 1. The standard is a set of rules
for projects where an AI agent writes much of the code: it asks for a written purpose, a log of
decisions, size limits that a command enforces, and tests for what the documentation claims. Each
project declares a level of stakes, which sets how much review a release needs. This one declares
**stakes `real`** (ADR-001), because a team depends on it and it can change Confluence pages that
other people read. The declaration lives in `.agent-standard`.

The standard's conformance check is kept outside this repository. `pnpm run standard` runs it when
the check sits beside this checkout, and otherwise prints that it was skipped, so a contributor
without the standard can still build and test.

### The decision log

`docs/decisions.md` is numbered and append-only. A record is never edited away or deleted. When a
decision changes, a later record supersedes or amends the earlier one and says which one it
replaces. This keeps the reasoning behind every past decision readable. The one exception is the wording-only pass
recorded in ADR-030, which the maintainer authorised and which changed no decision.

- **Each title states the decision as a sentence**, such as "The server answers this machine only",
  rather than naming a topic such as "Networking". A reader scanning the titles should learn what was
  decided without opening the record.
- **Each record has a `**Status:**` line** saying whether it is accepted, deferred or superseded.
- **Refusals are recorded as well as choices.** Writing down what was declined, and why, stops the
  same idea from being proposed again every session. A title that refuses something says so plainly,
  using words such as `not`, `no`, `never`, `instead of`, `declined` or `deferred`.
- **A decision is not made until it is written down.** Agreement reached in conversation goes into
  the log or into a design doc in the next change.
- **Some changes need a record before they happen:** adding or removing a dependency, changing a
  budget, or making an exception to one of the fences below. The commit that makes the change cites
  the record's number. A version bump within the existing set of dependencies does not need one.

### Comments record intent, never history

A code comment explains why the code is shaped the way it is, so that someone changing it later
understands what they might break. It does not describe what the code used to be. Git and the
decision log already hold that history, and a source file that repeats it becomes a changelog that
nobody maintains.

To check a comment, ask: **would it still make sense to someone who had never seen the previous
version?** If it only makes sense as "we got this wrong once", it belongs in the commit message.

The same test applies to documentation. Every document is written for someone reading it for the
first time, so a sentence that only makes sense to someone who saw an earlier draft should be
rewritten or removed.

**Documentation is written clearly and with purpose.** Use full sentences that say what something
is, why it matters, and what the reader should do about it. Define a term the first time it appears.
Prefer a plain explanation to a slogan. This applies to everything this project writes: the north
star, the decision log, the design docs, this file, and comments in code. The documents that came
with the repository template (the root README, CONTRIBUTING.md, and the design-doc README) keep the
template's wording; our additions to them follow this rule.

- **A bug fix ships with a test**, and the test's name describes the failure it guards against, so
  the suite records the story. A fixed setup failure ships with a doctor check instead, because a
  setup problem is detected on the user's machine rather than in the suite (ADR-016).
- **Keep explanations proportionate.** A 30-line function does not need 40 lines of comments. If the
  reasoning really is that long, it belongs in a design doc or a decision record, and the comment
  can point there.
- **Describe the code, not the person or process that wrote it.** Comments such as "I changed this
  to" or "now we" describe the session that produced the code and are meaningless later.
- **Prefer deleting a comment to keeping one that restates the line below it.**

### Checks

- **Run `pnpm run build` and then `pnpm test` before every commit.** The budgets (ADR-014, ADR-031) run
  as part of `pnpm test`, and `pnpm run budgets` prints them with their current values. A budget is a limit on the size or shape of the project, such as the number of
  lines of code or of runtime dependencies, chosen so that growth is a deliberate decision rather
  than an accident. If a change breaks a budget, do not work around the check: write a decision
  record that argues for the new number.
- **Say which suite ran.** `pnpm test` is the fast suite and does not include the end-to-end suite.
  `pnpm run test:e2e` runs against the Confluence test environment (`pnpm run testenv:start`) and
  skips itself when no environment is running. `pnpm run test:scale` times the server on a generated
  3,200-page space; it runs on a real machine, never in CI, and is run after changing code that reads
  a whole space (ADR-057). A report that "all tests pass" names the suite, so that a skipped
  end-to-end run is not mistaken for a passing one.
- **Every claim made to users names the test or CI job that proves it.** If nothing proves a claim,
  remove the claim.
- **Closed-world results go in the expectation table.** Some tests check a fixed, known set of
  results, such as which test pages a `.confluenceignore` file excludes. A new result in such a set
  is added to `expectations` in `test-env/fixtures/dataset.mjs`, and the failing test will say so.
- **When one fact is stated in two places**, once written by hand and once generated by tooling, a
  test checks that the two agree, so neither can drift.

### Load-bearing surfaces

A load-bearing surface is a part of the code where a mistake would leak data, change Confluence
without consent, or switch off one of the project's safeguards. Every change to one is flagged in
the pull request description and reviewed by a person. Because this project declares stakes `real`,
a stable release also ships only after a second person, not the one who opened it, approves the
pull request that releases it; that pull request lists these surfaces for its reviewer, and
`scripts/release-gate.mjs` refuses to publish without the approval (ADR-044). Until 1.0.0, a
maintainer named in the repository variable `RELEASE_MAINTAINERS` may merge a release pull request
without that approval (ADR-053). The paths below are
relative to `packages/simply-confluence-explorer/src/`.

| surface                         | where                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writes to Confluence            | `confluence/pagePush.ts`, the one write path, with `parser/editForm.ts`, which builds what it writes (ADR-058); `branches/branchRuns.ts` (ADR-024) with `branches/pageChanges.ts`, which picks the accepted changes (ADR-059); `drafts/drafts.ts` |
| HTTP to Confluence              | `confluence/client.ts`, the only module that imports simply-atlassian-core's clients (ADR-028)                                                                                                                                                    |
| HTTP to GitLab                  | `gitlab/client.ts`, the only module besides the Confluence client that reaches the network (ADR-050)                                                                                                                                              |
| Tokens                          | `confluence/connection.ts` (the Confluence token), `gitlab/client.ts` (the GitLab token), `util/privateFile.ts`                                                                                                                                   |
| Pages sent to AI providers      | `ai/providers.ts`, the only module that loads their SDKs (ADR-017)                                                                                                                                                                                |
| The outbound guard              | `ai/guard.ts` and the engine that runs it, `ai/engine.ts` (ADR-022), with its check of what was sent, `ai/manifest.ts` (ADR-054)                                                                                                                  |
| AI conversations and uploads    | `ai/sessions.ts` and its routes (ADR-023)                                                                                                                                                                                                         |
| AI keys                         | `ai/settings.ts`                                                                                                                                                                                                                                  |
| Telemetry kept on disk          | `telemetry/telemetry.ts`, which writes it, and `routes/observe.ts`, which serves it (ADR-054)                                                                                                                                                     |
| External processes              | `ai/geminiService.ts`                                                                                                                                                                                                                             |
| Deletes files                   | `spaces/spaceStore.ts` (purge)                                                                                                                                                                                                                    |
| Paths built from request values | `http/guards.ts` (validation), `within()` in `util/paths.ts`                                                                                                                                                                                      |
| Sensitive-data exclusion        | `spaces/exclusionManager.ts` and every caller of `isPageExcluded`                                                                                                                                                                                 |
| The enforcement itself          | `package.json` scripts and Wireit config, `.github/workflows/`, `test-env/`, `test/budgets.test.ts`, `scripts/release-gate.mjs`                                                                                                                   |

### The rules specific to this program

These rules protect the people whose pages and credentials the app handles. Each one is backed by a
decision record that explains it in full.

- **The server holds the Confluence connection.** A request from the browser never chooses which
  Confluence to talk to, and no token is ever sent back to a browser (ADR-019). This means a web page
  cannot redirect the app to another server or read the token.
- **An excluded page never leaves the machine.** Every path that sends page content to an AI goes
  through `gatePageForAi`. If that function cannot confirm a page is allowed, it refuses the page
  rather than sending it (it fails closed) (ADR-018).
- **Nothing reaches an AI without passing the outbound guard.** The provider code accepts only a
  `GuardedPayload`, a type that only the guard can create, so unguarded content does not compile. A
  new detector is added together with test cases in the guard's test corpus; the test fails until
  those cases exist (ADR-022).
- **The server answers this machine only.** It checks the Host and Origin of every request. Sharing
  it with other machines requires an explicit `--host` setting plus an allow-list of hosts, never a
  wider default (ADR-018).
- **A push names the page version it was made from.** If the page in Confluence has changed since
  then, the push is refused, so nobody's newer edit is overwritten.
- **A page is never written from Markdown if it would lose parts of itself.** Markdown has no form for
  images, macros, page links, mentions or task lists, so a page holding any of them is refused by
  the dry run and the push, which name what would be lost, rather than having them replaced with
  placeholder text (ADR-041).
- **The test dataset is the source of truth** for the test environment's spaces and their
  `.confluenceignore` files. Any generated copy is overwritten every time the environment is seeded
  (ADR-007).

### Instinct fences

An instinct fence is a rule against a mistake that has actually happened in agent-led work. Each one
is written down so that an agent recognises the urge before acting on it.

- **Answer the ask.** Do what was requested. If you see other work worth doing, propose it in your
  reply; do not add it to the change.
- **Fix in place.** Do not create parallel copies such as `_v2`, `_new` or `_old` files. When code is
  replaced, the new version and the deletion of the old one go in the same commit, so the repository
  never holds two versions of the same thing.
- **Never discard an error silently.** If ignoring an error is correct, add a comment that says why.
  An empty `catch` block hides failures that someone will later need to find.
- **Never weaken or delete a test to make the suite pass.** A failing test is reporting something
  real, so report what it found. A known defect that cannot be fixed yet becomes a `todo` test, which
  keeps it visible, rather than a deleted one.
- **Never claim something ran unless you have its command and output.** Anything you did not verify
  is labelled as unverified, including in reports about your own work.
- **Test the code, not the machine.** A test that checks whether a tool is installed passes on the
  machine where it was written and fails wherever the package is built. Tests should exercise the
  project's code with the inputs it controls.
- **Work is finished when the shipped app works, not when CI is green.** A passing workflow is one
  step. The work is done when the packed app has been installed and used against Confluence.
- **No local detail leaves the machine.** This repository is public. Absolute paths, hostnames,
  account names, real space keys and real page content must never appear in a commit, an issue, a
  comment or a document. Use the test dataset's generic names instead.
- **No placeholders without a tracking issue.** A `TODO` without a named issue tends to be forgotten.
  The number of TODOs is a budget declared in `.agent-standard`, and it is zero.
- **One diff, one intent.** A refactor and a bug fix ship as separate changes, so each can be
  reviewed and reverted on its own.
- **Security is not traded for convenience.** Turning off TLS verification, granting broad
  permissions, putting secrets in code, or building shell commands from strings each need a decision
  record that explains why.
- **Give the strongest argument against a proposal first**, and build only what still makes sense
  after it. Enthusiasm is not a reason to change direction; a decision record is.
- **Only checks that actually ran count as evidence.** The existence of documentation, tests or
  decision records does not show that the code works. What shows it is a check that was run and
  passed.
- **A rule needs a command that enforces it.** When you add a rule to this file, add the test or
  check that fails when the rule is broken, in the same commit. A rule nothing checks will drift.
- **Open the pull request when the work is done** and the checks pass, not before. Once a pull
  request is under review, do not keep pushing new work to it; open another one.

### Not yet armed

This section lists the checks this file mentions that nothing in the repository enforces yet. Each
item is removed in the commit that adds the command enforcing it.

Nothing is listed at present.
