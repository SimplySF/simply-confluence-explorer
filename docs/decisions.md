# Decisions

Numbered and append-only. A record is superseded or amended by a later record,
never edited away and never deleted. Titles state the decision rather than
naming a topic.

Refusals are recorded here as well as choices. A decision already declined is
settled, and a proposal to revisit it is answered with the record's number
rather than by arguing it again.

---

## ADR-001 — The project is held to the agent-led development standard at stakes `real`

**Status:** accepted, 2026-10-15.

A team depends on Confluence Explorer, and it can push edits to pages other
people read. That is the standard's `real` tier: others depend on it and data
is at risk.

What the tier adds, beyond the base standard:

- a second person answers the review packet for every load-bearing surface,
  independently, before a release;
- a full cold read of the codebase, not one package per release;
- a security review of the load-bearing surfaces by someone who did not build
  them;
- cross-model audits are a gate in addition to human review, never instead of
  it.

**The argument against:** `real` asks for a second reviewer, and the project
has one maintainer. Declaring a lower tier would make the check pass sooner.
It would also be false, and a project that understates its stakes to get past
its own gate has broken the standard in the first commit that claims it.
Until a second reviewer is named, releases are blocked rather than the tier
lowered.

---

## ADR-002 — Confluence Server and Data Center only; Atlassian Cloud is not a target

**Status:** accepted, 2026-10-15.

The client speaks the Server/Data Center REST API (`/rest/api/...`) and
authenticates with a Personal Access Token as a bearer token. Cloud uses
different endpoints, API tokens with basic auth, and a different content
model for newer pages. Supporting both doubles the surface that talks to
Confluence, which is load-bearing, for an audience that does not need it.

A request for Cloud support is answered with this record.

---

## ADR-003 — The test environment is a real Confluence Data Center, not a fake of its REST API

**Status:** accepted, 2026-10-15.

`npm run dev` and the CI end-to-end job run Atlassian's own Confluence Data
Center image, in podman or docker, against Postgres.

**The argument against, and it is a good one:** a small fake server would
start in under a second, need no license, and never change underneath us. It
was offered and declined. A fake encodes our reading of Confluence's
behaviour, so tests against it prove the code matches our assumptions, not
that it works against Confluence. The e2e suite exists to answer the second
question.

The fake would still be the right answer if the license (ADR-004) stops being
available. That is the condition under which this is revisited.

---

## ADR-004 — The test license is Atlassian's public three-hour developer key, renewed by restarting, instead of a trial license

**Status:** accepted, 2026-10-15.

Atlassian stopped selling Data Center to new customers on 2026-03-30, and the
trial-license page no longer issues keys for it. The only license available to
this project is the published developer "timebomb" key, committed at
`test-env/licenses/confluence-dc-timebomb.key` and passed to the container as
`ATL_LICENSE_KEY`.

Decoded, its expiry is the duration `P3H`, not a date. Confluence counts it
from startup: restarting the container moved the expiry reported by
`/rest/license/1.0/license/details` forward by the restart interval. So every
`npm run dev` starts with three hours, and `scripts/dev.mjs` restarts
Confluence about ten minutes before expiry, which costs about a minute of
downtime.

The key is for testing only. It never configures a Confluence anyone else
uses.

---

## ADR-005 — The setup wizard is driven over HTTP, with no browser automation and no pre-provisioned database snapshot

**Status:** accepted, 2026-10-15.

`test-env/lib/wizard.mjs` walks the setup wizard as forms: a cookie jar, the
hidden `atl_token`, and one POST per step. The license and database steps are
skipped by container environment variables.

Declined: a headless browser, which is a large dependency to click five
buttons; and a snapshot of an already-provisioned database, which is hundreds
of megabytes of opaque state tied to one Confluence version. The cost of the
HTTP approach is that the step names are specific to the version pinned in
`test-env/testenv.config.json`, so changing that version means re-walking the
wizard and updating `provision.mjs`.

---

## ADR-006 — `npm run dev` owns the test environment: it starts with the app and stops with it

**Status:** accepted, 2026-10-15.

`npm run dev` starts Postgres and Confluence, provisions and seeds them,
starts the API and UI connected to them, and stops all of it on Ctrl+C. Data
persists in named volumes between runs, and the seed adds only what is
missing.

Leaving Confluence running between sessions would make the next start
instant. It was declined in favour of nothing left running that the developer
did not start; it also gives every session a fresh license (ADR-004).
`npm run dev:mock` keeps the demo-data mode for work that needs no Confluence.

---

## ADR-007 — The test dataset is declarative and is the source of truth for the test spaces and their `.confluenceignore` files

**Status:** accepted, 2026-10-15.

`test-env/fixtures/dataset.mjs` declares the spaces, the page tree, the
`.confluenceignore` rules, and the expected outcome of each rule. The seeder
creates what is missing, rewrites `spaces/<KEY>/.confluenceignore` on every
run, and records the real page ids in `test-env/.state/seed-manifest.json` for
the tests.

Rewriting the ignore files means an edit made to them in the UI during
development does not survive the next start. That is the point: the e2e
expectations are written against the fixture, and a rule that drifts from it
makes every exclusion test a test of the drift.

---

## ADR-008 — The server's token is sent only to the server's URL

**Status:** accepted, 2026-10-15.

The server falls back to `CONFLUENCE_URL` and `CONFLUENCE_TOKEN` when a
request carries no connection. `resolveConnection`
(`server/src/confluence/envConnection.ts`) applies the token fallback only
when the request's URL is empty or equals `CONFLUENCE_URL`. A browser-supplied
URL with no token gets no token.

Without this, any URL typed into the UI would receive the server's credential
in an `Authorization` header.

---

## ADR-009 — The browser never receives the server's token

**Status:** accepted, 2026-10-15.

When the server has a connection of its own, the UI uses it by sending an
empty URL and token, and the server fills them in (ADR-008). `GET
/api/settings` reports that a token exists, never its value.

A connection the user saves in the UI is still stored in the browser's
`localStorage`, token included. That is a known exposure, recorded here
rather than fixed in passing; changing it changes how the settings dialog
works, and needs its own record.

---

## ADR-010 — `npm run prod` runs the built app against a real Confluence; it does not deploy anywhere

**Status:** accepted, 2026-10-15.

`scripts/prod.mjs` requires `CONFLUENCE_URL` and `CONFLUENCE_TOKEN` from `.env`
or the environment, builds, and serves the UI and API on one port. It refuses
to start without both, and it never uses the test environment's profile.

There is no container image, host, or deploy step. Adding one is a new
record, with the target named.

---

## ADR-011 — CI is GitHub Actions, and the end-to-end job runs a real Confluence Data Center in docker

**Status:** accepted, 2026-10-15. Unverified: the workflow has not run yet.

`.github/workflows/ci.yml` has a `unit` job and an `e2e` job. The e2e job runs
`node test-env/testenv.mjs start` with `CONTAINER_RUNTIME=docker`, which is
the same provisioning as `npm run dev`, then `npm run test:e2e`. A fresh CI
install always starts a full license period.

The docker path has not been run anywhere: the workstation has podman only.
Its first run is the first evidence it works.

---

## ADR-012 — The end-to-end suite runs on its own and is not part of `npm test`

**Status:** accepted, 2026-10-15.

`npm test` is the fast suite against mock data. `npm run test:e2e` runs
`server/src/e2e/*.e2e.ts` against the test environment, and skips with a
reason when it is not running. The e2e files are not named `*.test.ts`, so the
fast suite's glob cannot pick them up.

"All tests pass" therefore always names which suite ran.

---

## ADR-013 — Substring matching in `.confluenceignore` is not changed yet; the over-match is deferred to the maintainer

**Status:** deferred, 2026-10-15.

`ExclusionManager.matchesPattern` tries an anchored match and then an
unanchored one, so the rule `Restricted/` also hides a page titled
`Unrestricted Access Guide`. The e2e suite records this as a `todo` test.

Over-exclusion is the safe direction for sensitive-data rules: it hides too
much, never too little. Anchoring the match would fix the over-match and could
also expose pages that existing ignore files hide today only by accident.
Which of those matters more is the maintainer's call, and until it is made the
behaviour stays as it is.

---

## ADR-014 — The budgets are set at today's size with modest headroom, not at a target the code has not reached

**Status:** accepted, 2026-10-15.

The budgets arrived after the code, so they start from what exists and may
only tighten. `scripts/budgets.sh` asserts them and `npm run check` runs it.

| budget                                                              | limit                         | measured when set |
| ------------------------------------------------------------------- | ----------------------------- | ----------------- |
| code lines (`MAX_CODE_LINES`)                                       | 10,000                        | 8,756             |
| comment ratio (`MAX_COMMENT_RATIO`)                                 | 25%, **hard**                 | 2%                |
| live prose (`MAX_DOC_LINES`)                                        | 1,200 lines                   | 616               |
| runtime dependencies (`MAX_RUNTIME_DEPS`)                           | 16                            | 16                |
| dev dependencies (`MAX_DEV_DEPS`)                                   | 15                            | 15                |
| client bundle (`MAX_BUNDLE_BYTES`)                                  | 400 KiB                       | 316 KiB           |
| test floor (`MIN_TEST_RATIO`)                                       | 1 test line per 10 code lines | 1 per 9.3         |
| server modules making HTTP requests (`MAX_CONFLUENCE_HTTP_MODULES`) | 1                             | 1                 |
| modules running external processes (`MAX_EXEC_MODULES`)             | 2                             | 2                 |

The comment ratio is the one hard ceiling: over it, a comment is retired,
never the number raised. The rest are soft, which means the choice between
raising one and writing worse code belongs to the maintainer, who says the
ceiling is in the way rather than quietly trimming a guard to fit.

Dependencies are frozen at the current count: adding one means removing one
or writing a record. The last two rows assert architecture rather than size —
which file talks to Confluence, and which files start programs — and are the
two most valuable rows in the file.

**The argument against:** a test floor of one in ten is low, and the standard's
reference projects hold one in three. Setting it there today would fail the
check on the first run and stay failing, and a gate that is always red is one
that gets ignored. The floor is where the suite is; it tightens as tests are
added.

---

## ADR-015 — TLS verification is on by default; skipping it is an explicit choice per connection, never a default

**Status:** accepted, 2026-10-15.

The "allow self-signed certificates" option turns off certificate checking for
the connection to Confluence (`rejectUnauthorized: false` in
`server/src/confluence/client.ts`, and the same for the push tool in
`simplyClient.ts`). With it on, anyone able to sit between the app and
Confluence can read the token and every page.

It stays because many companies run Confluence Server behind an internal
certificate authority, and a tool that cannot connect there does not serve the
team it is for. It is off by default everywhere: the UI's connection dialogs,
the saved connection, the server's `ALLOW_SELF_SIGNED`, and the test
environment, which is plain HTTP and needs no exception.

Declined for now: replacing the switch with a setting that trusts a named
company certificate file. That keeps verification on and is the better answer.
It needs a file most users would have to go and find, and it is the change to
make when the switch is first seen turned on for a connection that could have
used a certificate instead.

---

## ADR-016 — The setup is checked by a doctor, and a fixed setup failure ships with the check that detects it

**Status:** accepted, 2026-10-15.

`npm run doctor` (and `GET /api/doctor` for the connection a browser is using)
runs every check in `CHECK_IDS` (`server/src/doctor/checks.ts`) and prints one
line each: `✓` working, `!` works but something is unavailable, `✗` broken, `-`
not applicable. Every `!` and `✗` carries a `fix:` line saying what to type. It
ends by saying which capabilities the setup has — browse, sync, exclusions, ai,
push — and a capability is listed only when every check behind it passes. Only
a `✗` exits non-zero.

The checks read the machine through `DoctorDeps`, so the doctor's own tests
use values, not a machine. The test that holds `CHECK_IDS` against what runs
fails until a new check is listed and given a capability.

`npm run dev` runs it after provisioning and `npm run prod` after building, and
neither starts on a `✗`: anything that sets things up verifies its own work.

The rule that keeps it worth running: **a setup failure that gets fixed ships
with a doctor check that detects it.** A unit test asks what the code does; the
doctor asks what the machine has. A test that asks whether something is
installed is moved here.

**The argument against:** the UI already tests a connection and reports AI
status, so a doctor repeats them. It does not duplicate the code — it calls
the same client and services — and it answers where the UI cannot: before the
app starts, in CI, and as the last step of `npm run dev` and `npm run prod`.

---

## ADR-017 — The AI is chosen in Settings: the Gemini CLI or the Claude, ChatGPT or Gemini API, with keys kept on the server

**Status:** accepted, 2026-10-15. Open: the shared-server case (below).

Four providers sit behind one engine (`server/src/ai/engine.ts`), and every
feature that asks an AI goes through it:

- **Gemini CLI**, run as `node <bundle>` with no shell. The bundle is found from
  a configured path, then PATH (the `gemini.cmd` shim on Windows, the `gemini`
  symlink elsewhere), then the npm prefix and portable Node installs under
  `%LOCALAPPDATA%\Programs` on Windows.
- **Claude**, through Anthropic's SDK: streamed, effort `high`, defaulting to
  `claude-opus-5-5`, with the server-side refusal fallback requested when
  talking to Anthropic directly.
- **ChatGPT**, through OpenAI's SDK and the Responses API. No default model:
  Settings lists the models the key can use.
- **Gemini API**, through Google's SDK, defaulting to the `gemini-pro-latest`
  alias.

Each API provider takes an optional endpoint, so a company AI gateway can stand
in for the public API.

**Keys are written once and never read back.** Settings sends a key to the
server, which keeps it in `config/ai-settings.json`, mode `0600`, written
atomically; the browser is told only whether a key is set and where it came
from. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `AI_PROVIDER`
and `GEMINI_CLI_PATH` in the environment are fallbacks; a value saved in
Settings wins over them.

**Dependencies: 16 → 19** (`MAX_RUNTIME_DEPS`): `@anthropic-ai/sdk`, `openai`
and `@google/genai`. The maintainer chose the official SDK for each provider
over hand-written HTTP; Anthropic's guidance is to call Claude through its SDK.
The cost is the largest new review surface in the project, so it is fenced:
`MAX_AI_SDK_MODULES` holds the three SDKs to `server/src/ai/providers.ts`, the
one file that sends Confluence content to a third party.

**The argument against:** the Gemini CLI was enough to use the AI features, and
every provider added is another place pages can go. What answers it is that
the provider is the maintainer's choice of where pages go, and that the
exclusion rules run before the engine is called, whichever provider it is.

**Open: a shared server.** Settings changes the AI for everyone using that
server, so on a shared deployment anyone who can open the UI can change the
provider and key. That is acceptable while each person runs the app locally.
How it will be deployed is undecided; a shared deployment needs this revisited
before it ships.

---

## ADR-018 — The server answers this machine only, and a page that cannot be checked is not sent to an AI

**Status:** accepted, 2026-10-15.

Three rules, each closing a hole found in review:

- **Local only.** The server listens on `127.0.0.1`, unless `HOST` says
  otherwise. Requests are refused unless their `Host` is one of this machine's
  names, plus any in `ALLOWED_HOSTS`. A browser request is refused unless the
  page that sent it is served from one of those names. Bodies are JSON only, so
  a plain form on another site cannot post here. The `cors` package is
  removed: no cross-origin response is ever allowed.
- **Identifiers are shaped, and paths stay inside their directory.** Space keys,
  page ids and job ids are validated wherever they arrive: route, body or query.
  `within()` refuses any path that resolves outside its data directory, and
  `sanitizeFilename` maps `.` and `..` to `_`. Before this, a space key of `..`
  zipped the project root, `.env` and the AI key file included.
- **The AI gate fails closed.** Every route that sends a page to an AI calls
  `gatePageForAi` (`server/src/spaces/aiGate.ts`). It checks the cached copy, or
  else the live page, against `.confluenceignore`. A page that cannot be looked
  up is not sent. Sub-pages fetched live are filtered, and the space site map is
  filtered against the current rules rather than trusted as written. An
  unreadable `.confluenceignore` excludes its whole space.

One rule for writes: **a push names the version it was made from.** The server
compares that with the page's current version and refuses with 409 if they
differ, because the push tool otherwise writes over whatever is there. The
frontmatter block is stripped before anything is written, and after a push the
cached copy is replaced from Confluence, body included.

**The argument against local-only:** a team that wants one shared instance now
has to set `HOST` and `ALLOWED_HOSTS`. That is the point: sharing is a decision
(ADR-017's open item), not a default.

**Dependencies:** `cors` and `@types/cors` are removed. The budgets keep their
ceilings (`MAX_RUNTIME_DEPS`, ADR-017), which may tighten later.

---

## ADR-019 — The server holds the Confluence connection; a request never chooses its own Confluence

**Status:** accepted, 2026-10-15. Supersedes ADR-008 and amends ADR-009.

The connection (URL, Personal Access Token, the self-signed choice) is kept by
the server (`server/src/confluence/connection.ts`): set in Settings and written
to `config/connection.json`, mode `0600`. `CONFLUENCE_URL` in the environment
takes precedence and cannot be changed from Settings, so a deployment's own
configuration is the one in force. `GET /api/connection` returns everything
except the token; `PUT /api/connection` sets it.

Requests no longer carry `x-confluence-*` headers, and the server ignores them.
Before this, every request named the Confluence it wanted and could bring a
token, which made each route a place where the server's credentials and a
caller's URL could meet (ADR-008 fenced that at one function). With one
connection there is nothing to fence. Testing a connection before saving it
(`POST /api/auth/verify`) reuses the saved token only for the saved URL, and
a new URL saved without a new token drops the old token.

The browser never held the server's token (ADR-009). Now it holds no token at
all: the copy older versions kept in `localStorage`, in plain text, is
deleted when the app loads.

**The argument against:** each person's browser could have kept its own
connection, which is the shared-server case's natural shape. That case is open
(ADR-017, ADR-018), and a per-browser token in plain text is the wrong answer
to it either way.

---

## ADR-020 — Demo mode and the batch export pipeline are removed, not kept beside the test environment

**Status:** accepted, 2026-10-15.

**Demo mode** answered every Confluence call from built-in data when no URL was
set: about 400 lines in the client and routes, and a silent fallback that
showed fake pages when a server was misconfigured. The Confluence test
environment (ADR-003) does that job for development with real behaviour. The
fast suite runs against a stand-in (`server/src/test-fixtures/fakeConfluence.ts`)
that answers the same data over HTTP in REST shapes, so tests go through the
production client instead of around it. With nothing configured, the app and
the doctor say so.

**The batch export pipeline** (the export job manager, the ZIP archiver, the
disk writer and four routes) was reachable only from a dialog nothing
rendered. Sync to disk and the space ZIP are the offline copies. Its tests
went with it.

A proposal to bring either back is answered with this record.

---

## ADR-021 — The code budget rises to 15,000 lines because the cleanup paid for it; the test floor and dependency ceilings tighten

**Status:** accepted, 2026-10-15.

The roadmap's feature phases (the outbound guard, sessions and uploads, branch
actions, the page co-writer) were estimated at 3,500–5,000 lines, against a
code budget with 545 lines left. The maintainer agreed to a raise on one
condition: cleanup first, and the cut measured.

Measured by `scripts/budgets.sh`, before and after the cleanup:

|                            | before  | after   |
| -------------------------- | ------- | ------- |
| code lines                 | 9,571   | 8,225   |
| test lines                 | 1,461   | 2,175   |
| runtime / dev dependencies | 19 / 15 | 18 / 14 |

The cut was dead code (the export pipeline, two unrendered dialogs, ADR-020),
demo mode (ADR-020), one request and error layer instead of 24 copies, one
service instance instead of one per router, one job runner instead of two
copies of the same bookkeeping, and one metadata generator instead of two.
The compiler now fails on unused imports, locals and parameters
(`noUnusedLocals` / `noUnusedParameters`), so what was cut does not grow back.

So:

- `MAX_CODE_LINES` → **15,000**: the 8,225 measured plus the upper estimate,
  with about 1,800 lines of margin.
- `MIN_TEST_RATIO` → **5** (one test line per five code lines, from ten). The
  suite now has one per 3.8; a floor at five keeps new features carrying tests.
- `MAX_RUNTIME_DEPS` → **18** and `MAX_DEV_DEPS` → **14**: the current counts.

**The argument against:** a budget raised in the same programme that will spend
it is a budget that bends. What answers it is the order: the lines were
removed first and measured, and the other ceilings moved down at the same time.
A second raise inside this roadmap would trip the standard's own failure
condition (any budget raised twice) and needs the shrink review it prescribes.

---

## ADR-022 — Every AI request passes an outbound guard: secrets stop it, personal data is replaced, and nothing can be sent around it

**Status:** accepted, 2026-10-15.

`.confluenceignore` keeps whole pages from an AI. The guard is the second
layer, for what an allowed page may still contain. It runs in the engine
(`server/src/ai/engine.ts`) on everything sent: the user's request, the page,
sub-pages, space context and the title.

- **Secrets block.** Private keys, cloud and SaaS tokens (AWS, GitHub, GitLab,
  Slack, Atlassian, Google, Anthropic/OpenAI, Stripe), JSON web tokens,
  connection strings with a password, and `password = …` style assignments.
  Placeholder values such as `********`, `<your password>` and `${VAR}` are not
  findings. A refusal (422) names the kind and the line, never the value.
- **Personal data is replaced** with placeholders (`[EMAIL-1]`, `[PHONE-1]`, …),
  stable within a conversation: emails, phone numbers, US social security
  numbers, card numbers (prefix and checksum), IBANs (checksum). The reply has
  the values put back locally, so the person reading it sees them and the model
  never did, and an Improve proposal cannot write a placeholder into a page.
- **Per space,** `spaces/<KEY>/.confluenceguard` adds `block:`, `redact:` and
  `allow:` rules. A rule that does not parse refuses AI requests, and the doctor
  reports it (`guard-rules`): a protection that silently fails to load is a
  leak.
- **Multi-page context leaves the page out instead of refusing.** A sub-page or
  a space-context page holding a secret is dropped and named in the answer's
  summary; one page cannot block every question about its space. A single page
  asked about directly is refused.

**Enforced by structure, not convention.** `complete` and `runGeminiCli` accept
only a `GuardedPayload`, which only `OutboundGuard.inspect` constructs, so
unguarded text does not compile. `MAX_AI_SENDER_IMPORTERS` holds the senders to
one importer, the engine. Every request is recorded in `data/ai-audit.jsonl`
(`0600`): time, engine, space, size and what was replaced. It never records content.

**The argument against:** pattern detectors miss what they were not written
for and sometimes flag what is harmless. Both are true. The answer is that they
are a second layer, not the first, and that each kind of miss has a remedy:
`block:` and `redact:` rules for the first, `allow:` rules for the second. The
detectors are held to a corpus of real-shaped samples and near-misses, closed
in both directions (`server/src/ai/guard.test.ts`).

---

## ADR-023 — Conversations live on the server, and uploaded files are context extracted to text, never Confluence content

**Status:** accepted, 2026-10-15.

A conversation (`server/src/ai/sessions.ts`) is about one page, a page and its
sub-pages (a branch), or a space. It is kept in `data/sessions/<id>.json`,
mode `0600`, so it survives a reload and is resumed when that page or space is
opened again. Each turn sends the earlier turns with it, newest first up to
`HISTORY_CHAR_LIMIT`, as a real message array to each provider.

**Every turn rebuilds its context** from the scope: the page is checked by the
exclusion gate again, a branch is collected again, and a space's pages are
retrieved for the new question. A rule changed between turns applies at once.
The context leads the first message and stays byte-identical across turns, so
providers that cache prompts (Claude, marked with `cache_control`) do not pay
for it again. A branch is capped at `CONTEXT_CHAR_LIMIT`; pages past the cap are
named as left out, never dropped silently.

**The guard keeps its placeholders per conversation.** The placeholder map is
saved with the session, so `[EMAIL-1]` means the same person on every turn and
after a restart. The map holds real values. It stays on this machine and is
never returned to a browser.

**Uploaded files are text, extracted here.** PDF, HTML (converted to
Markdown), Markdown, plain text, CSV, JSON, YAML and XML are accepted, up to
10 MB and `FILE_CHAR_LIMIT` of text each; anything else is refused with a
reason. A file is context for the conversation, not part of Confluence: it is
not subject to `.confluenceignore`, and the UI says so. It is subject to the
outbound guard like everything else. That is why a PDF is sent as its
extracted text and not as a document: the guard cannot read inside a PDF, and
ADR-022 allows nothing to reach an AI unguarded. Layout and images in a PDF
are not sent.

**Dependencies: 18 → 19** (`MAX_RUNTIME_DEPS`): `unpdf`, a server build of
Mozilla's PDF.js with no dependencies of its own, pinned to an exact version
released more than two weeks before it was added. The maintainer chose text
extraction over refusing PDFs or sending them unguarded.

**The argument against:** a conversation store is state that can go stale or
hold more than intended. It holds what the person typed and the answers they
were shown, which they could already see. It is local, private to the server's
user, and deletable per conversation.

---

## ADR-024 — Branch work goes through a review queue: nothing is written that a person did not accept, page by page

**Status:** accepted, 2026-10-15.

"Work on branch" acts on a page and everything under it
(`server/src/branches/branchRuns.ts`), as a run saved in `data/branch-runs/`.

- **Review** sends the branch as one context (capped, exclusions and the
  outbound guard applied) and asks for findings in a fixed shape: incorrect,
  redundant, stale, structure, gap. It changes nothing.
- **Improve** asks for a proposal per page, each sent on its own. The person
  accepts (optionally with edits), rejects or undecides each page. Dry run and
  push act on accepted pages only, one at a time, through the one write path
  (`server/src/confluence/pagePush.ts`): each is checked against the version its
  proposal was made from, so a page a colleague changed since is refused and
  named, while the others go.

A page holding a secret is skipped and named; an excluded page is never listed.
A run being filled is one shared object, so a decision made while proposals
arrive is not lost to the next save.

**Declined: pushing a branch in one step.** It is faster and it is the change
this tool exists not to make: a person reads each page before it changes
(north star). **Declined for now: cancelling a page mid-request.** Stop takes
effect between pages.

## ADR-025 — A page is created only after a check for pages that already say it, which the author has answered

**Status:** accepted, 2026-10-15.

"New page" (`server/src/drafts/drafts.ts`) is a draft session under a chosen
parent. Before any drafting, the planned title and notes are searched for in
the existing pages: a local BM25 index over the synced copy
(`server/src/spaces/searchIndex.ts`, no new dependency, excluded pages never
indexed) and a live CQL search for pages not synced. Each candidate passes the
exclusion gate before it is shown or sent, and the AI, if configured, judges how
much each one overlaps.

The author then answers: **update that page instead** (creation is refused, and
Improve is the way), **link to it and continue** (the linked pages become the
co-writer's context), or **continue anyway**. The co-writer does not run, and
the page cannot be created, until that answer is recorded on the draft.

The co-writer proposes a whole revised draft between fixed markers; it is kept
on the turn as a proposal and shown as a diff, never applied without the author.
Every turn passes the outbound guard. Creating is a dry run, then the create,
through the one write path (`server/src/confluence/pagePush.ts`); a title that
already exists in the space is refused, not overwritten.

**Dependencies: dev 14 → 17** (`MAX_DEV_DEPS`): `eslint`,
`eslint-plugin-react-hooks` and `@typescript-eslint/parser`, run as
`npm run lint --workspace=client` inside `npm run check` with only the
Rules-of-Hooks rule on. A hook placed after an early return blanked the whole UI
while every other check passed; the rule is the command that disagrees with it.

**The space's table of contents opens from the space bar,** beside Update Space
and ZIP, not as a page tab: it describes the space, not the page.

**Declined: creating without the check** when the AI is not configured. The
search still runs and the author still answers; only the overlap judgement is
missing, and the dialog says so.

## ADR-026 — The page has four tabs, a space's actions live in one Space menu, and branch work starts from the page, not that menu

**Status:** accepted, 2026-10-15. Amends ADR-025: the table of contents sits
with Update space and the ZIP in the Space menu, rather than as buttons beside
them.

- **Header:** connection, New page, Snippet parser, Settings, theme.
- **Sidebar:** jump to a URL or id, one space switcher (synced spaces first,
  then the rest of Confluence), the **Space** menu (sync, AI summaries, table
  of contents, ZIP, exclusions and leak guard, remove stale cache), the page
  filter and the tree.
- **Page:** Work on branch, Open in Confluence, and a menu (copy, download,
  remove from this machine), over four tabs: **Read** (rendered, Markdown,
  storage XML), **Ask AI** (this page, with sub-pages, or the whole space),
  **Improve**, **Details**. The panels stay mounted, so a question or an edited
  proposal survives a tab switch.
- **Settings** holds the connection and the AI provider only. Exclusions and
  guard rules are a space's, so they are edited from its menu.

Saving exclusions still deletes, by default, the synced copies the new rules
exclude, because a ZIP is built from the synced copy. The checkbox now says so
and can be cleared, and the outcome is reported instead of happening silently.

The UI's own promises have commands that disagree with them: every class name
has a rule (`server/src/docs/clientStyles.test.ts`); colours come from the
theme's variables, and outcomes are toasts or inline, never `alert()` or
`confirm()` (`server/src/docs/clientConventions.test.ts`). A review run records
the id of each page it read, so a finding opens the page it names.

**Declined: branch actions in the Space menu.** A branch is a page and what is
under it, so it starts from the page. **Declined for now: a component test
runner.** It is new dependencies for a small UI; keyboard, dialog and theme
behaviour are checked by walking the app in a browser, and that check is manual.

---

## ADR-027 — The project adopts the SimplySF template: one package, pnpm, a Svelte frontend, and design docs for features beside this log

**Status:** accepted, 2026-10-15.

The code lives in `SimplySF/simply-confluence-explorer` and takes that
repository's shape:

- **One package**, `packages/simply-confluence-explorer`: a `node:http` server
  in `src/`, a Svelte 5 frontend in `web/`, and the `confluence-explorer`
  command in `bin/`. The three npm workspaces (`shared`, `server`, `client`)
  fold into it; the API types both halves need are one module, imported by
  the frontend as types only.
- **pnpm, Lerna and Wireit**, ESM throughout, Vitest, and the template's
  ESLint and Prettier rules. CI runs on Linux and Windows.
- **The React UI is rewritten in Svelte.** The layout and behaviour ADR-026
  settled carry over unchanged; only the framework moves.

**Two records, split by job.** A feature, screen, route or change to how the
app starts or stores credentials gets a design doc in `docs/design/`, as the
template requires. A design doc says what a feature is and how it behaves, and
is corrected when the implementation teaches it something. This log keeps
what is not a feature: the rules, the budgets, exceptions to a fence, and
every refusal. A design doc cites records by number rather than restating
them, and a refusal made while designing a feature is recorded here as well,
so what is settled stays in one file.

Commands named in earlier records map as follows: `npm run check` is
`pnpm run build` then `pnpm test`; `npm run dev` is `pnpm run dev`;
`npm run prod` is `pnpm start`; `npm run doctor` is `confluence-explorer
doctor`; `npm test` and `npm run test:e2e` keep their names under pnpm. Paths
under `server/src/` and `client/src/` are under the package's `src/` and
`web/src/`.

**Declined: keeping React.** It would have been the smaller move, and it
departs from a structure the repository requires.

**The argument against:** two kinds of record means two places to look, and a
reader may not know which holds an answer. The template makes design docs
mandatory, and folding the refusals into them would scatter what is settled
across one file per feature, to be found only by someone who already knew
which feature to look under. The split costs a sentence of orientation in
`AGENTS.md`.

---

## ADR-028 — Confluence is reached through simply-atlassian-core; our own HTTP client and the spawned push tool are retired

**Status:** accepted, 2026-10-15. Amends ADR-014: the HTTP row counts the
modules that import the library's clients, and the exec row drops to the
Gemini CLI alone.

`@simplysf/simply-atlassian-core` is the library the push tool is built on.
It has no runtime dependencies, uses Node's `fetch`, retries 429 and 5xx with
`Retry-After`, and converts between Markdown and storage format in process.
The template asks for it in preference to a second client.

- `src/confluence/client.ts` stays the one module that talks to Confluence:
  it wraps the library's `ConfluenceClient`, and nothing else imports it.
- A push converts and writes in process, through the library's page-update
  functions, instead of starting a separate program. The version check, the
  frontmatter strip and the refresh after a push are unchanged.
- axios, cheerio, turndown and its GFM plugin, the push tool and its host are
  removed. Design doc 0002 lists what remains and why.

**The argument against:** the library says Server and Data Center are
implemented but not yet verified against a live instance, and Data Center is
the only target (ADR-002). Its Markdown conversion is also not ours, so pages
on disk and in prompts will read differently. The end-to-end suite runs
against a real Data Center (ADR-003), so this project is where that
verification happens; the change that swaps the converter carries a fixture
test that puts the old output beside the new for every page in the test
dataset, and any difference is reported in that pull request rather than
accepted quietly.

---

## ADR-029 — The test environment is started on its own, not by `pnpm run dev`

**Status:** accepted, 2026-10-15. Amends ADR-006.

`pnpm run dev` is the template's: the server and the Vite dev server, as
Wireit services. Starting Postgres and Confluence from it would turn a
contributor's first command into a container boot of several minutes that needs
podman or docker. The test environment is `pnpm run testenv:start`, and
`testenv:down` stops it; the doctor says when the app is pointed at a test
environment that is not running.

ADR-006's reason holds: nothing runs that the developer did not start, now
by a separate command.

**The argument against:** one command that brought up everything was the
fastest path to a working app against a real Confluence. It still is two
commands, and the template's quick start is the one most contributors need.
