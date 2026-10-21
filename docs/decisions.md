# Decisions

This file records the project's decisions, one numbered record per decision. It is append-only: a
record is never edited away or deleted. When a decision changes, a later record supersedes or
amends the earlier one, and both stay in the file, so a reader can always see what was decided and
why. Each record's title is a sentence that states the decision itself, not the topic it concerns.

The log records refusals as well as choices. When something has been considered and declined, the
record explains why. If the same idea is proposed again, the answer is a pointer to that record's
number, and the discussion does not have to start over.

---

## ADR-001 — The project is held to the agent-led development standard at stakes `real`

**Status:** accepted, 2026-10-15. Amended by ADR-044, which replaces the written review packet
with a second person's approval of the release pull request.

The agent-led development standard sorts projects into tiers by what is at stake if they go wrong.
Confluence Explorer belongs in the `real` tier, the tier for projects that other people depend on
and that can put data at risk. A team relies on this app, and the app can push edits to Confluence
pages that other people read.

The `real` tier adds these requirements to the base standard:

- Before a release, a second person independently answers the review packet for every
  load-bearing surface. A load-bearing surface is a part of the code where a mistake would cause
  real harm, such as the code that writes to Confluence.
- Each release gets a full cold read of the codebase, not a read of one package at a time.
- Someone who did not build the load-bearing surfaces reviews them for security.
- Audits by a different AI model are a gate in addition to human review. They never replace it.

**The argument against:** the `real` tier requires a second reviewer, and the project currently
has one maintainer. Declaring a lower tier would let the conformance check pass sooner. It would
also be untrue, and a project that understates its stakes to get past its own gate has broken the
standard in the very commit that claims to follow it. Until a second reviewer is named, releases
are blocked instead of the tier being lowered.

---

## ADR-002 — Confluence Server and Data Center only; Atlassian Cloud is not a target

**Status:** accepted, 2026-10-15.

The app talks to the Server and Data Center REST API (`/rest/api/...`) and authenticates with a
Personal Access Token sent as a bearer token. Atlassian Cloud uses different endpoints,
authenticates with API tokens over basic auth, and stores newer pages in a different content
model. Supporting both would double the code that talks to Confluence, which is one of the
project's load-bearing surfaces, and the people who use this app do not need Cloud.

A request to support Cloud is answered by pointing to this record.

---

## ADR-003 — The test environment is a real Confluence Data Center, not a fake of its REST API

**Status:** accepted, 2026-10-15.

`npm run dev` and the end-to-end job in CI both run Atlassian's own Confluence Data Center image,
in podman or docker, backed by Postgres.

**The argument against, and it is a good one:** a small fake server would start in under a
second, would need no license, and would never change unexpectedly. That option was considered
and declined. A fake can only behave the way we believe Confluence behaves, so tests against it
prove that the code matches our assumptions, not that the code works against Confluence. The
end-to-end suite exists to answer the second question, which only a real Confluence can.

A fake would become the right choice if the license described in ADR-004 stopped being
available. That is the condition under which this decision should be revisited.

---

## ADR-004 — The test license is Atlassian's public three-hour developer key, renewed by restarting, instead of a trial license

**Status:** accepted, 2026-10-15.

Atlassian stopped selling Data Center to new customers on 2026-03-30, and its trial-license page
no longer issues Data Center keys. The only license this project can use is Atlassian's published
developer key, sometimes called the "timebomb" key. It is committed at
`test-env/licenses/confluence-dc-timebomb.key` and passed to the container as `ATL_LICENSE_KEY`.

When the key is decoded, its expiry turns out to be a duration, `P3H` (three hours), rather than a
date. Confluence counts those three hours from the moment it starts: restarting the container moved
the expiry reported by `/rest/license/1.0/license/details` forward by the time between the
restarts. As a result, every `npm run dev` starts with a full three hours, and `scripts/dev.mjs`
restarts Confluence about ten minutes before the license expires. Each restart costs about a
minute of downtime.

The key is for testing only. It is never used to configure a Confluence that anyone else relies
on.

---

## ADR-005 — The setup wizard is driven over HTTP, with no browser automation and no pre-provisioned database snapshot

**Status:** accepted, 2026-10-15.

A fresh Confluence must be taken through its setup wizard before it can be used.
`test-env/lib/wizard.mjs` completes the wizard by submitting its forms directly over HTTP. It
keeps the session cookies, carries the hidden `atl_token` field from page to page, and sends one
POST request per wizard step. The license and database steps are skipped entirely, because
container environment variables supply those values.

Two alternatives were declined. A headless browser would be a large dependency added only to
click five buttons. A snapshot of an already-provisioned database would be hundreds of megabytes
of state that nobody can inspect, and it would only work with one Confluence version. The HTTP
approach has its own cost: the wizard's step names belong to the Confluence version pinned in
`test-env/testenv.config.json`. Changing that version means walking through the wizard again and
updating `provision.mjs` to match.

---

## ADR-006 — `npm run dev` owns the test environment: it starts with the app and stops with it

**Status:** accepted, 2026-10-15.

`npm run dev` starts Postgres and Confluence, provisions and seeds them, and starts the API and
the UI connected to them. Pressing Ctrl+C stops all of it. The data is kept in named volumes
between runs, and the seed step adds only what is missing.

Leaving Confluence running between sessions would make the next start instant. That option was
declined so that nothing keeps running that the developer did not start. Starting Confluence fresh
each session also gives every session a full license period (ADR-004). `npm run dev:mock` keeps
the demo-data mode available for work that does not need Confluence at all.

---

## ADR-007 — The test dataset is declarative and is the source of truth for the test spaces and their `.confluenceignore` files

**Status:** accepted, 2026-10-15.

`test-env/fixtures/dataset.mjs` declares the test spaces, their page trees, the
`.confluenceignore` rules, and the result each rule is expected to produce. The seeder creates any
pages that are missing, rewrites `spaces/<KEY>/.confluenceignore` on every run, and records the
real page ids in `test-env/.state/seed-manifest.json` so the tests can find them.

Because the seeder rewrites the ignore files, an edit made to them through the UI during
development is lost at the next start. This is intentional. The end-to-end tests are written
against the rules in the dataset, and if the rules on disk drifted away from it, every exclusion
test would end up testing the drift instead of the code.

---

## ADR-008 — The server's token is sent only to the server's URL

**Status:** accepted, 2026-10-15.

When a request carries no connection details, the server falls back to the `CONFLUENCE_URL` and
`CONFLUENCE_TOKEN` it was configured with. `resolveConnection`
(`server/src/confluence/envConnection.ts`) applies the token fallback only when the request's URL
is empty or equal to `CONFLUENCE_URL`. If the browser supplies some other URL without a token, no
token is added.

Without this rule, any URL typed into the UI would receive the server's credential in an
`Authorization` header, and a mistyped or malicious address would collect it.

---

## ADR-009 — The browser never receives the server's token

**Status:** accepted, 2026-10-15.

When the server has a connection of its own, the UI uses it by sending an empty URL and token, and
the server fills them in (ADR-008). `GET /api/settings` reports whether a token exists, but never
returns its value.

A connection that the user saves in the UI is still stored in the browser's `localStorage`, and
that includes its token. This is a known exposure. It is recorded here rather than fixed as a side
effect of other work, because fixing it changes how the settings dialog works, and that change
needs its own record.

---

## ADR-010 — `npm run prod` runs the built app against a real Confluence; it does not deploy anywhere

**Status:** accepted, 2026-10-15.

`scripts/prod.mjs` reads `CONFLUENCE_URL` and `CONFLUENCE_TOKEN` from `.env` or the environment,
builds the app, and serves the UI and the API on one port. It refuses to start unless both values
are set, and it never uses the test environment's profile.

The project has no container image, no host and no deploy step. Adding any of them requires a new
record that names the deployment target.

---

## ADR-011 — CI is GitHub Actions, and the end-to-end job runs a real Confluence Data Center in docker

**Status:** accepted, 2026-10-15. Unverified: the workflow has not run yet.

Continuous integration runs on GitHub Actions. The workflow, `.github/workflows/ci.yml`, has two
jobs: a `unit` job that runs the fast suite, and an `e2e` job that runs the end-to-end suite against
a real Confluence Data Center.

The `e2e` job starts the test environment with `node test-env/testenv.mjs start`, setting
`CONTAINER_RUNTIME=docker` because GitHub's runners provide docker rather than podman. This is the
same provisioning that `npm run dev` performs locally. Once Confluence is up, the job runs
`npm run test:e2e`. Because every CI run starts from a fresh install, each one also starts a full
three-hour license period (ADR-004).

The docker path has not been run anywhere yet, because the development workstation has only podman.
The workflow's first run will therefore be the first evidence that the docker path works, and until
then this record is marked unverified.

---

## ADR-012 — The end-to-end suite runs on its own and is not part of `npm test`

**Status:** accepted, 2026-10-15.

The project has two test suites, and they are run separately:

- `npm test` runs the fast suite against mock data. It needs nothing but the code, so it can run on
  every change.
- `npm run test:e2e` runs the files in `server/src/e2e/*.e2e.ts` against the test environment. When
  the test environment is not running, the suite skips and says why, rather than failing.

The end-to-end files are deliberately not named `*.test.ts`. The fast suite finds its tests by that
pattern, so the naming alone keeps the slow suite out of it.

Because there are two suites, a report that "all tests pass" must always say which suite ran.

---

## ADR-013 — Substring matching in `.confluenceignore` is not changed yet; the over-match is deferred to the maintainer

**Status:** deferred, 2026-10-15.

`ExclusionManager.matchesPattern` decides whether a page title matches a rule in
`.confluenceignore`. It first tries an anchored match, which compares the rule against the whole
title, and then falls back to an unanchored match, which accepts the rule anywhere in the title.
The fallback over-matches: the rule `Restricted/` also hides a page titled
`Unrestricted Access Guide`. The end-to-end suite records this known defect as a `todo` test.

For rules that protect sensitive data, over-exclusion is the safe direction of error, because it
hides too much rather than too little. Anchoring the match would fix the over-match, but it could
also expose pages that existing ignore files currently hide only because of it. Deciding which of
those risks matters more is the maintainer's call. Until that decision is made, the matching
behaviour stays as it is.

---

## ADR-014 — The budgets are set at today's size with modest headroom, not at a target the code has not reached

**Status:** accepted, 2026-10-15.

A budget is a limit on the size or shape of the project, checked by a command, so that growth is a
deliberate decision rather than something that happens unnoticed. These budgets were introduced
after the code already existed, so they start from what the code measured at the time, and from here
they may only tighten. `scripts/budgets.sh` checks them, and `npm run check` runs that script.

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

The comment ratio is the only hard ceiling. If the code goes over it, a comment is removed; the
number is never raised. The other budgets are soft. When one of them gets in the way, the choice
between raising it and writing worse code to stay under it belongs to the maintainer. The person who
hits the limit says so openly, rather than quietly weakening a safeguard to make the code fit.

The dependency counts are frozen at their current values, so adding a dependency means either
removing another or writing a decision record that justifies it. The last two rows measure the
architecture rather than size: they check which file talks to Confluence and which files start other
programs. They are the two most valuable rows in the script, because they keep those answers to a
single, known place.

**The argument against:** a test floor of one test line for every ten code lines is low; the
standard's reference projects hold one in three. Setting the floor at one in three today, however,
would fail the check on its first run and keep failing, and a check that is always red soon gets
ignored. The floor is therefore set where the suite is now, and it tightens as tests are added.

---

## ADR-015 — TLS verification is on by default; skipping it is an explicit choice per connection, never a default

**Status:** accepted, 2026-10-15.

The "allow self-signed certificates" option turns off TLS certificate verification for the
connection to Confluence. It does this with `rejectUnauthorized: false` in
`server/src/confluence/client.ts`, and in the same way for the push tool in `simplyClient.ts`. With
verification off, anyone who can place themselves between the app and Confluence can read the token
and every page that passes over the connection.

The option is kept because many companies run Confluence Server behind an internal certificate
authority, whose certificates a default Node installation does not trust. A tool that cannot connect
in that setting cannot serve the team it was built for. The option is off by default everywhere: in
the UI's connection dialogs, in the saved connection, in the server's `ALLOW_SELF_SIGNED` setting,
and in the test environment, which uses plain HTTP and so needs no exception.

**Declined for now:** replacing the switch with a setting that trusts a named company certificate
file. That approach keeps verification on, and it is the better answer. It is not built yet because
it asks most users to locate a certificate file they may never have dealt with. It becomes the right
change the first time the switch is seen turned on for a connection that could have used a
certificate instead.

---

## ADR-016 — The setup is checked by a doctor, and a fixed setup failure ships with the check that detects it

**Status:** accepted, 2026-10-15.

The doctor is a command that checks whether this machine is set up to run the app. `npm run doctor`
runs every check listed in `CHECK_IDS` (`server/src/doctor/checks.ts`), and `GET /api/doctor` runs
the same checks for the connection a browser is using. Each check prints one line, marked with one
of four symbols:

- `✓` means it works.
- `!` means it works, but something it could use is unavailable.
- `✗` means it is broken.
- `-` means the check does not apply to this setup.

Every `!` and `✗` line carries a `fix:` line that says what to type to fix it. The report ends by
listing the capabilities the setup has (browse, sync, exclusions, ai and push), and a capability is
listed only when every check behind it passes. Only a `✗` makes the command exit with a non-zero
status.

The checks read the machine through an interface, `DoctorDeps`, so the doctor's own tests supply
values instead of depending on whatever the test machine has installed. A test holds `CHECK_IDS`
against the checks that actually run; it fails until a new check is added to the list and assigned
to a capability.

`npm run dev` runs the doctor after provisioning the test environment, and `npm run prod` runs it
after building. Neither starts the app if a check reports `✗`. The principle is that anything which
sets something up also verifies its own work.

One rule keeps the doctor worth running: **a setup failure that gets fixed ships with a doctor check
that detects it.** A unit test asks what the code does, while the doctor asks what the machine has.
A test that asks whether something is installed therefore belongs in the doctor, not in the test
suite.

**The argument against:** the UI can already test a connection and report the AI's status, so the
doctor repeats those checks. It does not duplicate the code, though: it calls the same client and
services the UI uses. And it can answer in places the UI cannot reach: before the app starts, in CI,
and as the last step of `npm run dev` and `npm run prod`.

---

## ADR-017 — The AI is chosen in Settings: the Gemini CLI or the Claude, ChatGPT or Gemini API, with keys kept on the server

**Status:** accepted, 2026-10-15. Open: the shared-server case (below).

Four AI providers sit behind one engine, `server/src/ai/engine.ts`, and every feature that asks an
AI anything goes through that engine. The person using the app chooses the provider in Settings:

- **Gemini CLI**, Google's command-line tool, run as `node <bundle>` with no shell in between. The
  app looks for the bundle in a configured path first, then on PATH (the `gemini.cmd` shim on
  Windows, the `gemini` symlink elsewhere), and then under the npm prefix and the portable Node
  installs in `%LOCALAPPDATA%\Programs` on Windows.
- **Claude**, through Anthropic's SDK. Responses are streamed, effort is set to `high`, and the model
  defaults to `claude-opus-5-5`. When the app talks to Anthropic directly, it also requests the
  server-side refusal fallback.
- **ChatGPT**, through OpenAI's SDK and its Responses API. There is no default model; instead,
  Settings lists the models the saved key is allowed to use.
- **Gemini API**, through Google's SDK. The model defaults to the `gemini-pro-latest` alias.

Each API provider accepts an optional endpoint, so a company's own AI gateway can stand in for the
public API.

**Keys are written once and never read back.** When a person saves a key in Settings, the browser
sends it to the server, which writes it atomically to `config/ai-settings.json` with file mode
`0600`, readable only by the user who runs the app. From then on, the browser is told only whether a
key is set and where it came from, never the key itself. The environment variables
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `AI_PROVIDER` and `GEMINI_CLI_PATH` act as
fallbacks; a value saved in Settings takes precedence over them.

**Dependencies: 16 → 19** (`MAX_RUNTIME_DEPS`). The three added dependencies are
`@anthropic-ai/sdk`, `openai` and `@google/genai`. The maintainer chose each provider's official SDK
over hand-written HTTP calls, and Anthropic's own guidance is to call Claude through its SDK. These
SDKs are the largest new surface in the project that a reviewer has to understand, so they are
confined: `MAX_AI_SDK_MODULES` holds all three to `server/src/ai/providers.ts`, the one file that
sends Confluence content to a third party.

**The argument against:** the Gemini CLI alone was enough to use every AI feature, and each added
provider is another place that pages can be sent. The answer is that which provider receives the
pages is the maintainer's decision to make, and that the exclusion rules run before the engine is
called, whichever provider is selected.

**Open: a shared server.** A change in Settings changes the AI for everyone who uses that server. On
a shared deployment, then, anyone who can open the UI can change the provider and the key. That is
acceptable while each person runs the app on their own machine. How the app will eventually be
deployed has not been decided, and a shared deployment needs this question revisited before it
ships.

---

## ADR-018 — The server answers this machine only, and a page that cannot be checked is not sent to an AI

**Status:** accepted, 2026-10-15.

This record sets three rules, each of which closes a hole found in review:

- **The server is local only.** It listens on `127.0.0.1` unless the `HOST` setting says otherwise.
  It refuses any request whose `Host` header is not one of this machine's names or a name listed in
  `ALLOWED_HOSTS`. It also refuses any browser request sent from a page that is not served from one
  of those names. Request bodies must be JSON, so an ordinary HTML form on another website cannot
  post to the server. The `cors` package is removed, so the server never allows a cross-origin
  response.
- **Identifiers must have the right shape, and paths stay inside their directory.** Space keys, page
  ids and job ids are validated wherever they arrive, whether in the route, the body or the query
  string. `within()` refuses any path that resolves outside its data directory, and
  `sanitizeFilename` turns `.` and `..` into `_`. Before these checks existed, a space key of `..`
  would have zipped the project root, including `.env` and the AI key file.
- **The AI gate fails closed.** Every route that sends a page to an AI first calls `gatePageForAi`
  (`server/src/spaces/aiGate.ts`). The gate checks the cached copy of the page against
  `.confluenceignore`, or the live page if there is no cached copy. If the page cannot be looked up,
  it is not sent. Sub-pages fetched live are filtered in the same way, and the space's site map is
  filtered against the current rules instead of being trusted as it was written. If a space's
  `.confluenceignore` cannot be read, the whole space is treated as excluded.

The record also sets one rule for writes: **a push names the version it was made from.** The server
compares that version with the page's current version in Confluence and refuses the push with a 409
response if they differ. Without this check, the push tool would write over whatever the page
currently holds, including changes someone else made in the meantime. The frontmatter block is
removed before anything is written, and after a successful push the cached copy is replaced from
Confluence, including the page body.

**The argument against local-only:** a team that wants one shared instance must now set `HOST` and
`ALLOWED_HOSTS` itself. That extra step is intended. Sharing the server is a decision that has not
been made yet (it is ADR-017's open item), and it should not happen by default.

**Dependencies:** `cors` and `@types/cors` are removed. The dependency budgets keep their current
ceilings (`MAX_RUNTIME_DEPS`, ADR-017) for now, and may be tightened later.

---

## ADR-019 — The server holds the Confluence connection; a request never chooses its own Confluence

**Status:** accepted, 2026-10-15. Supersedes ADR-008 and amends ADR-009.

The connection to Confluence consists of the URL, the Personal Access Token and the choice about
self-signed certificates. The server keeps it, in `server/src/confluence/connection.ts`. A person
sets it in Settings, and the server writes it to `config/connection.json` with file mode `0600`. If
`CONFLUENCE_URL` is set in the environment, it takes precedence and cannot be changed from Settings,
so that a deployment's own configuration is the one in force. `GET /api/connection` returns
everything about the connection except the token, and `PUT /api/connection` sets it.

Requests no longer carry `x-confluence-*` headers, and the server ignores them if they appear.
Previously, every request named the Confluence it wanted and could bring its own token. That made
every route a place where the server's credentials could be combined with a URL the caller chose,
which ADR-008 contained by confining it to one function. With a single connection held by the
server, there is nothing left to contain. Testing a connection before saving it
(`POST /api/auth/verify`) reuses the saved token only when the URL being tested is the saved URL, and
saving a new URL without a new token discards the old token.

The browser never held the server's token (ADR-009). It now holds no token of any kind: when the app
loads, it deletes the plain-text copy that older versions kept in `localStorage`.

**The argument against:** each person's browser could have kept its own connection, which would be
the natural shape for a shared server. That case is still open (ADR-017, ADR-018), and a token stored
per browser in plain text would be the wrong answer to it in any case.

---

## ADR-020 — Demo mode and the batch export pipeline are removed, not kept beside the test environment

**Status:** accepted, 2026-10-15.

**Demo mode** answered every Confluence call from built-in sample data whenever no URL was set. It
took about 400 lines across the client and the routes, and it had a dangerous side effect: when a
server was misconfigured, the app silently showed fake pages instead of reporting the problem. The
Confluence test environment (ADR-003) now does the job demo mode did for development, and it does it
with real Confluence behaviour. The fast suite runs against a stand-in,
`server/src/test-fixtures/fakeConfluence.ts`, which serves the same data over HTTP in the shapes of
the REST API, so the tests exercise the production client instead of going around it. With no
Confluence configured, the app and the doctor say so.

**The batch export pipeline** consisted of the export job manager, the ZIP archiver, the disk writer
and four routes. It could be reached only from a dialog that nothing in the app displayed. Syncing a
space to disk and downloading the space ZIP already provide offline copies, so the pipeline was
removed, along with its tests.

A proposal to bring back either feature is answered with this record.

---

## ADR-021 — The code budget rises to 15,000 lines because the cleanup paid for it; the test floor and dependency ceilings tighten

**Status:** accepted, 2026-10-15. Amended by ADR-062, which raises the code budget to 16,500 lines.

The roadmap's next feature phases were the outbound guard, conversations with uploaded files,
branch actions and the page co-writer. Together they were estimated at 3,500 to 5,000 lines of code,
and the code budget had only 545 lines left. The maintainer agreed to raise the budget on one
condition: the existing code would be cleaned up first, and the reduction would be measured before
the new number was set.

`scripts/budgets.sh` measured the code before and after the cleanup:

|                            | before  | after   |
| -------------------------- | ------- | ------- |
| code lines                 | 9,571   | 8,225   |
| test lines                 | 1,461   | 2,175   |
| runtime / dev dependencies | 19 / 15 | 18 / 14 |

The lines removed came from these changes:

- dead code was deleted: the export pipeline and two dialogs that were never rendered (ADR-020);
- demo mode was removed (ADR-020);
- 24 copies of request and error handling were replaced by one shared layer;
- each router had created its own service instance, and now they share one;
- two copies of the same job bookkeeping were replaced by one job runner;
- two metadata generators were replaced by one.

The compiler now fails on unused imports, local variables and parameters (`noUnusedLocals` and
`noUnusedParameters`), so code that has been cut cannot quietly come back.

The budgets were then set as follows:

- `MAX_CODE_LINES` rises to **15,000**. That is the 8,225 lines measured, plus the upper estimate for
  the feature phases, plus about 1,800 lines of margin.
- `MIN_TEST_RATIO` tightens to **5**, meaning at least one line of test for every five lines of code
  (it was one for every ten). The suite currently has one test line for every 3.8 code lines; a
  floor of five makes sure new features keep arriving with tests.
- `MAX_RUNTIME_DEPS` tightens to **18** and `MAX_DEV_DEPS` to **14**, which are the counts after the
  cleanup.

**The argument against:** raising a budget inside the same programme of work that will spend it
suggests the budget will bend whenever it gets in the way. The answer is the order in which this was
done: the lines were removed and measured first, and the other ceilings were lowered at the same
time as this one was raised. The standard treats any budget raised twice as a sign of failure, so a
second raise during this roadmap would require the shrink review the standard prescribes.

---

## ADR-022 — Every AI request passes an outbound guard: secrets stop it, personal data is replaced, and nothing can be sent around it

**Status:** accepted, 2026-10-15.

`.confluenceignore` keeps whole pages away from an AI. The outbound guard is a second layer of
protection, for sensitive content that a page which is allowed may still contain. It runs in the
engine (`server/src/ai/engine.ts`) and inspects everything that is about to be sent: the user's
request, the page, its sub-pages, any space context and the page title.

- **Secrets stop the request.** The guard detects private keys; cloud and service tokens (AWS,
  GitHub, GitLab, Slack, Atlassian, Google, Anthropic and OpenAI, Stripe); JSON web tokens;
  connection strings that contain a password; and `password = …` style assignments. Placeholder
  values such as `********`, `<your password>` and `${VAR}` are not treated as secrets. When a
  request is refused, the response (a 422) names the kind of secret and the line it was on, but never
  the value itself.
- **Personal data is replaced with placeholders** such as `[EMAIL-1]` and `[PHONE-1]`, which stay the
  same throughout a conversation. This covers email addresses, phone numbers, US social security
  numbers, card numbers (recognised by prefix and checksum) and IBANs (recognised by checksum). When
  the reply comes back, the real values are put back in on this machine, so the person reading the
  answer sees them while the model never did. This also means an Improve proposal cannot write a
  placeholder into a page.
- **Each space can add its own rules** in `spaces/<KEY>/.confluenceguard`, using `block:`, `redact:`
  and `allow:` lines. If a rule cannot be parsed, AI requests for that space are refused and the
  doctor reports the problem (`guard-rules`). A protection that silently fails to load would let
  content through that the space owner meant to stop.
- **When the context spans many pages, a page with a secret is left out instead of refusing the whole
  request.** A sub-page or space-context page that holds a secret is dropped, and the answer's summary
  names it. Otherwise one page could block every question about its space. A single page that is asked
  about directly is refused.

**The guard is enforced by the structure of the code, not by convention.** The functions that send
to an AI, `complete` and `runGeminiCli`, accept only a `GuardedPayload`, and only
`OutboundGuard.inspect` can construct one. Text that has not passed the guard therefore does not
compile. `MAX_AI_SENDER_IMPORTERS` limits the modules that import those senders to one, the engine.
Every request is recorded in `data/ai-audit.jsonl` (mode `0600`) with the time, the engine, the
space, the size and what was replaced. The audit log never records content.

**The argument against:** pattern detectors miss things they were not written to find, and they
sometimes flag things that are harmless. Both are true. The answer is that the guard is the second
layer of protection, not the first, and that each kind of mistake has a remedy: `block:` and
`redact:` rules catch what the detectors miss, and `allow:` rules clear what they flag wrongly. The
detectors are tested against a corpus of realistic samples and near-misses that is closed in both
directions, so every sample must be caught and every near-miss must be let through
(`server/src/ai/guard.test.ts`).

---

## ADR-023 — Conversations live on the server, and uploaded files are context extracted to text, never Confluence content

**Status:** accepted, 2026-10-15. Amended by ADR-048.

A conversation (`server/src/ai/sessions.ts`) is about one page, about a page and its sub-pages
(called a branch), or about a whole space. It is stored in `data/sessions/<id>.json` with mode
`0600`, so it survives a reload of the browser and is resumed when that page or space is opened
again. Each new turn sends the earlier turns along with it, newest first, up to
`HISTORY_CHAR_LIMIT` characters, as a proper message array in each provider's own format.

**Every turn rebuilds its context from the conversation's scope.** The page is checked against the
exclusion rules again, a branch's pages are collected again, and a space's pages are retrieved again
for the new question. A rule that changes between two turns therefore applies immediately. The
context is placed at the start of the first message and stays byte-for-byte identical from turn to
turn, so providers that cache prompts (Claude, where it is marked with `cache_control`) do not charge
for it again. A branch's context is capped at `CONTEXT_CHAR_LIMIT` characters; pages beyond the cap
are named in the answer as left out, never dropped silently.

**The guard keeps its placeholders for the whole conversation.** The map from placeholders to real
values is saved with the session, so `[EMAIL-1]` refers to the same person on every turn, even after
a restart. Because the map holds real values, it stays on this machine and is never sent to a
browser.

**Uploaded files are converted to text on this machine.** The accepted types are PDF, HTML
(converted to Markdown), Markdown, plain text, CSV, JSON, YAML and XML, up to 10 MB per file and
`FILE_CHAR_LIMIT` characters of text. Any other type is refused with a reason. An uploaded file is
context for the conversation, not part of Confluence, so `.confluenceignore` does not apply to it,
and the UI says so. The outbound guard does apply to it, as it does to everything else. That is why
a PDF is sent as its extracted text rather than as a document: the guard cannot inspect the inside
of a PDF, and ADR-022 allows nothing to reach an AI without passing the guard. As a result, the
layout and images of a PDF are not sent.

**Dependencies rise from 18 to 19** (`MAX_RUNTIME_DEPS`) to add `unpdf`, a server build of
Mozilla's PDF.js that has no dependencies of its own. It is pinned to an exact version that was
released more than two weeks before it was added. The maintainer chose extracting the text over the
two alternatives, refusing PDFs or sending them unguarded.

**The argument against:** a conversation store is saved state, and saved state can go stale or end
up holding more than anyone intended. What it holds is what the person typed and the answers they
were shown, which they could already see. It is kept locally, readable only by the user the server
runs as, and each conversation can be deleted.

---

## ADR-024 — Branch work goes through a review queue: nothing is written that a person did not accept, page by page

**Status:** accepted, 2026-10-15. Amended by ADR-041, ADR-046, ADR-047, ADR-059 and ADR-061.

"Work on branch" acts on a page and everything under it (`server/src/branches/branchRuns.ts`). Each
piece of work is a run, saved in `data/branch-runs/`. There are two kinds of run:

- **Review** sends the branch to the AI as one context, with the size cap, the exclusion rules and
  the outbound guard applied. It asks for findings in a fixed set of categories: incorrect,
  redundant, stale, structure and gap. A review changes nothing.
- **Improve** asks for a proposed revision of each page, sending each page on its own. The person then
  decides about every page: accept it (with or without their own edits), reject it, or leave it
  undecided. The dry run and the push act only on accepted pages, one at a time, through the one
  write path (`server/src/confluence/pagePush.ts`). Each page is checked against the version its
  proposal was made from, so if a colleague has changed a page since, that page is refused and named
  while the other accepted pages are still written.

A page that holds a secret is skipped and named, and an excluded page is never listed at all. While
a run is still being filled with proposals, it is held as one shared object, so a decision the person
makes while proposals are arriving is not overwritten by the next save.

**Declined: pushing a whole branch in one step.** It would be faster, but it is exactly the kind of
change this tool exists to prevent: the north star requires that a person reads each page before it
changes. **Declined for now: cancelling a page while its request is in progress.** Stopping a run
takes effect between pages.

---

## ADR-025 — A page is created only after a check for pages that already say it, which the author has answered

**Status:** accepted, 2026-10-15.

"New page" (`server/src/drafts/drafts.ts`) opens a draft session under a parent page the author
chooses. Before any drafting starts, the planned title and the author's notes are searched for among
the existing pages, in two ways: a local BM25 search index over the synced copy
(`server/src/spaces/searchIndex.ts`, which needs no new dependency and never indexes excluded
pages), and a live CQL search for pages that have not been synced. Every candidate page passes the
exclusion check before it is shown or sent anywhere. If an AI is configured, it then judges how much
each candidate overlaps with the planned page.

The author must then choose one of three answers:

- **update that page instead**, in which case creating the new page is refused and the existing page
  is improved through Improve;
- **link to it and continue**, in which case the linked pages become context for the co-writer;
- **continue anyway**.

The co-writer does not run, and the page cannot be created, until the author's answer is recorded on
the draft.

The co-writer proposes a complete revised draft between fixed markers. The proposal is kept with the
turn that produced it and shown as a diff, and it is never applied without the author's approval.
Every turn passes the outbound guard. Creating the page means a dry run followed by the create
itself, through the one write path (`server/src/confluence/pagePush.ts`). If a page with the same
title already exists in the space, the create is refused rather than overwriting it.

**Dev dependencies rise from 14 to 17** (`MAX_DEV_DEPS`) to add `eslint`,
`eslint-plugin-react-hooks` and `@typescript-eslint/parser`. They run as
`npm run lint --workspace=client` inside `npm run check`, with only the Rules of Hooks rule enabled.
A React hook placed after an early return once left the whole UI blank while every other check
passed, and this rule is the check that catches that mistake.

**The space's table of contents opens from the space bar,** next to Update Space and ZIP, rather
than as a tab on the page, because it describes the whole space and not the current page.

**Declined: creating a page without the check** when no AI is configured. The search still runs and
the author still has to answer; only the AI's judgement of the overlap is missing, and the dialog
says so.

---

## ADR-026 — The page has four tabs, a space's actions live in one Space menu, and branch work starts from the page, not that menu

**Status:** accepted, 2026-10-15. Amends ADR-025: the table of contents sits with Update space and
the ZIP in the Space menu, rather than as buttons beside them. Amended by ADR-046 and ADR-049.

The layout is:

- **Header:** the connection status, New page, Snippet parser, Settings and the theme switch.
- **Sidebar:** a box to jump to a page by URL or id; one space switcher, listing synced spaces first
  and then the rest of Confluence; the **Space** menu, which holds sync, AI summaries, the table of
  contents, the ZIP download, exclusions and the leak guard, and removing stale cached pages; and
  finally the page filter and the page tree.
- **Page:** Work on branch, Open in Confluence, and a menu with copy, download and remove from this
  machine. Below them are four tabs:
  - **Read** shows the page rendered, as Markdown, or as storage XML;
  - **Ask AI** asks about this page, this page with its sub-pages, or the whole space;
  - **Improve** proposes a revision;
  - **Details** shows the page's AI summary, its Confluence details and its attachments.

  The tab panels stay mounted when hidden, so a half-typed question or an edited proposal survives a
  switch to another tab.

- **Settings** holds only the connection and the AI provider. Exclusions and guard rules belong to a
  space, so they are edited from that space's menu.

Saving new exclusion rules still deletes, by default, the synced copies of pages the new rules
exclude, because the space ZIP is built from the synced copy. A checkbox in the dialog now explains
this and can be cleared, and the result is reported to the person rather than happening silently.

Each of the UI's own conventions is backed by a test that fails when it is broken. Every CSS class a
component uses must have a rule (`server/src/docs/clientStyles.test.ts`). Colours must come from the
theme's variables, and outcomes must be shown as toasts or inline messages, never with `alert()` or
`confirm()` (`server/src/docs/clientConventions.test.ts`). A review run also records the id of each
page it read, so a finding can open the page it refers to.

**Declined: branch actions in the Space menu.** A branch is a page together with everything under
it, so branch work starts from that page. **Declined for now: a component test runner.** It would
mean new dependencies for a small UI. Instead, keyboard, dialog and theme behaviour are checked by
walking through the app in a browser, and that check is manual.

---

## ADR-027 — The project adopts the SimplySF template: one package, pnpm, a Svelte frontend, and design docs for features beside this log

**Status:** accepted, 2026-10-15.

The code lives in the `SimplySF/simply-confluence-explorer` repository and follows that
repository's structure:

- **One package**, `packages/simply-confluence-explorer`, contains a `node:http` server in `src/`, a
  Svelte 5 frontend in `web/`, and the `confluence-explorer` command in `bin/`. The three npm
  workspaces the app used before (`shared`, `server` and `client`) are folded into it. The API types
  that both the server and the frontend need are kept in one module, which the frontend imports as
  types only.
- **The tooling is the template's:** pnpm, Lerna and Wireit, ESM throughout, Vitest for tests, and
  the template's ESLint and Prettier rules. CI runs on both Linux and Windows.
- **The React UI is rewritten in Svelte.** The layout and behaviour settled in ADR-026 carry over
  unchanged; only the framework changes.

**There are two kinds of record, each with its own job.** A feature, a screen, a route, or a change
to how the app starts or stores credentials gets a design doc in `docs/design/`, as the template
requires. A design doc describes what a feature is and how it behaves, and it is corrected whenever
the implementation shows it to be wrong. This decision log keeps everything that is not a single
feature: the project's rules, its budgets, any exceptions to a fence, and every refusal. A design doc
refers to records here by number instead of repeating them. A refusal made while designing a feature
is also recorded here, so that everything already settled can be found in one file.

Commands named in earlier records correspond to these commands now:

- `npm run check` is `pnpm run build` followed by `pnpm test`;
- `npm run dev` is `pnpm run dev`;
- `npm run prod` is `pnpm start`;
- `npm run doctor` is `confluence-explorer doctor`;
- `npm test` and `npm run test:e2e` keep their names under pnpm.

Paths that earlier records give under `server/src/` and `client/src/` are now under the package's
`src/` and `web/src/`.

**Declined: keeping React.** It would have been the smaller change, but it departs from a structure
the repository requires.

**The argument against:** two kinds of record means two places to look, and a reader may not know
which one holds the answer to their question. The template makes design docs mandatory, so they
cannot be dropped. Folding the refusals into them instead would spread what is settled across one
file per feature, where only someone who already knew which feature to look under could find it.
Keeping both costs one sentence of orientation in `AGENTS.md`.

---

## ADR-028 — Confluence is reached through simply-atlassian-core; our own HTTP client and the spawned push tool are retired

**Status:** accepted, 2026-10-15. Amends ADR-014: the HTTP row counts the modules that import the
library's clients, and the exec row drops to the Gemini CLI alone.

`@simplysf/simply-atlassian-core` is the library that the push tool is built on. It has no runtime
dependencies of its own, makes its requests with Node's built-in `fetch`, retries 429 and 5xx
responses while respecting `Retry-After`, and converts between Markdown and Confluence's storage
format inside the process. The template asks projects to use it rather than writing a second client.

- `src/confluence/client.ts` remains the one module that talks to Confluence. It wraps the library's
  `ConfluenceClient`, and no other module imports that client.
- A push now converts and writes the page inside the server process, using the library's page-update
  functions, instead of starting a separate program. The version check, the removal of frontmatter
  before converting, and the refresh of the local copy after a push all work as before.
- axios, cheerio, turndown and its GFM plugin, the push tool and the command that hosted it are
  removed. Design doc 0002 lists the dependencies that remain and the reason for each.

**The argument against:** the library's own documentation says its Server and Data Center support is
implemented but has not yet been verified against a live instance, and Data Center is this project's
only target (ADR-002). Its Markdown conversion is also different from the one this project used, so
pages saved to disk and pages sent in prompts will read differently. The answer is that this
project's end-to-end suite runs against a real Data Center (ADR-003), so this project is where that
verification will happen. The change that swaps the converter will include a fixture test that sets
the old output beside the new output for every page in the test dataset, and that pull request will
report every difference rather than accepting them quietly.

---

## ADR-029 — The test environment is started on its own, not by `pnpm run dev`

**Status:** accepted, 2026-10-15. Amends ADR-006.

`pnpm run dev` belongs to the template: it starts the server and the Vite dev server as Wireit
services. If it also started Postgres and Confluence, a contributor's first command would become a
container start-up that takes several minutes and requires podman or docker. Instead, the test
environment is started with `pnpm run testenv:start` and stopped with `testenv:down`. The doctor
reports when the app is configured to use a test environment that is not running.

The reason behind ADR-006 still holds: nothing runs that the developer did not start. The difference
is that the developer now starts the test environment with its own command.

**The argument against:** a single command that brought everything up was the fastest way to get a
working app connected to a real Confluence. It now takes two commands, and the template's quick
start is the one most contributors need.

---

## ADR-030 — The decision log was reworded once for clarity, and no decision in it was changed

**Status:** accepted, 2026-10-15. An exception, authorised by the maintainer, to the rule that a
record is never edited.

The records up to ADR-029 were first written in a clipped, compressed style: short fragments,
slogans in place of explanations, and sentences that assumed the reader already knew the project.
The maintainer judged that style unacceptable for this repository, which a new contributor or the
repository owner should be able to read without help. Every record from ADR-001 to ADR-029 was
therefore rewritten once, in full sentences that say what was decided and why.

The rewrite was limited to wording. These things were kept exactly, and were checked against the
previous text before the change was committed:

- every record's number, title and order;
- every `**Status:**` line's status and date, and every statement that a record supersedes or
  amends another;
- every number, table value, file path, command and identifier, and every budget name in the record
  that names it;
- every citation of one record by another.

Where the rewrite added a sentence, it explains something the record already relied on, such as
what a term means or why a rule exists. It does not add a rule.

The append-only rule still holds for everything else. A future change of wording is not made this
way. It is made by a new record that supersedes the old one, as for any other change.

**The argument against:** an append-only log is trustworthy because nothing in it is ever
rewritten, and this is a rewrite. Two things answer it. First, the rewrite was made immediately
after the log was first merged into this repository, before any later record or design doc had come
to rely on its earlier wording. Second, this record says exactly what changed and what did not, and
the earlier wording remains in the git history, in the commit that first added the log.

---

## ADR-031 — The budgets are counted on the template's layout and enforced by `pnpm test`, instead of by a shell script

**Status:** accepted, 2026-10-15. Amends ADR-014 and ADR-021 where they name `scripts/budgets.sh`
and describe what it counts.

The budgets are now measured by `scripts/budgets.mjs`, a Node script. The package's
`test/budgets.test.ts` runs that script and turns each budget into its own test, so a failure names
the budget that was broken and the files that broke it. `pnpm run budgets` prints the same
measurements for a person to read.

The budgets moved out of a shell script because this repository's CI runs on Windows as well as
Linux, and Windows runners do not run shell scripts. A budget that only some runners check would
drift on the others without anyone noticing. Making the budgets part of `pnpm test` means every
runner enforces them, and so does every contributor who runs the tests.

What is counted had to change along with the layout, so these numbers are set again:

| budget                                                                                     | limit       | measured when set |
| ------------------------------------------------------------------------------------------ | ----------- | ----------------- |
| live prose (`MAX_DOC_LINES`)                                                               | 2,400 lines | 2,085             |
| runtime dependencies (`MAX_RUNTIME_DEPS`)                                                  | 7           | 0                 |
| dev dependencies (`MAX_DEV_DEPS`)                                                          | 29          | 26                |
| modules importing the library's clients or calling `fetch` (`MAX_CONFLUENCE_HTTP_MODULES`) | 1           | 0                 |
| modules running external processes (`MAX_EXEC_MODULES`)                                    | 1           | 0                 |

Each change, and the reason for it:

- **Prose** now includes the template's contributing guides and the design docs the template
  requires, and the documentation is written in full explanatory sentences (ADR-030), which take
  more lines than the earlier clipped style. The Contributor Covenant is adopted text rather than
  text this project wrote, so it is not counted. History and review stay excluded, as before,
  because append-only documents cannot be shortened.
- **Runtime dependencies** are capped at the seven that design doc 0002 names and argues for. The
  number is set once here so that the pull requests bringing those dependencies in do not each have
  to raise it.
- **Dev dependencies** are the template's own tooling (26) plus three that the move needs:
  `@lucide/svelte` for icons, `marked` for rendering Markdown, and `@types/archiver` for the ZIP
  library's types.
- **Code and comments** no longer count the license header that the linter requires at the top of
  every file, or a Svelte `<style>` block, which is a stylesheet rather than code. The header is the
  same fifteen lines everywhere and says nothing about the code below it.
- **The HTTP row** counts the modules that import simply-atlassian-core's `ConfluenceClient` or
  `HttpTransport`, or that call `fetch` themselves. It no longer counts imports of `node:http`,
  because the server needs that module to serve the app (ADR-028).
- **The exec row** allows one module, the Gemini CLI runner, because pushing to Confluence no longer
  starts a separate program (ADR-028).

The code budget, the comment ceiling, the test floor, the bundle size and the AI rows are unchanged.

The unit-test task is also told about the files these tests read, such as the documentation, the
scripts and the built bundle. Wireit, the template's build tool, skips a task whose input files have
not changed, so without this a change to the documentation alone would not re-run the tests that
check it.

**The argument against:** the runtime and dev dependency ceilings are set above today's counts,
and ADR-014 said budgets start at what exists. The difference here is that every addition is named
in an agreed design doc. A ceiling set at zero would be raised three times by the pull requests that
follow, and a budget raised repeatedly is the standard's own warning sign that the budget is not
being held.

---

## ADR-032 — Certificates are always verified; an internal certificate authority is trusted with `NODE_EXTRA_CA_CERTS` instead of a switch that turns checking off

**Status:** accepted, 2026-10-15. Supersedes ADR-015.

The app reaches Confluence through simply-atlassian-core (ADR-028), and that library always verifies
TLS certificates. It offers no way to turn verification off, and it refuses the
`CONFLUENCE_SSL_VERIFY=false` setting that other Atlassian tools accept, with an error explaining
why. The "allow self-signed certificates" switch that ADR-015 kept therefore cannot work any more,
and it is removed from the connection, from Settings and from the doctor.

A company that runs Confluence behind its own certificate authority is still supported, in the way
ADR-015 already named as the better answer. The person starts the app with the environment variable
`NODE_EXTRA_CA_CERTS` set to the path of that authority's certificate file. Node then trusts
certificates the authority issued, and every other certificate is still checked as usual. The doctor
names the file when the variable is set, so the arrangement is visible rather than hidden.

**The argument against:** ADR-015 kept the switch because finding a certificate file is harder for
most people than ticking a box, and some will now be unable to connect until they have found one.
That is true, and it is the cost of never sending the token over a connection that anyone in the
middle could read. The doctor's message and the README say what to do, and the person's IT
department will usually have the file, because their browsers already need it.

---

## ADR-033 — Pages are converted by simply-atlassian-core even though it still loses five things, which are tracked as failing tests and fixed in the library instead of worked around here

**Status:** accepted, 2026-10-16.

ADR-028 promised a comparison before the library's Markdown converter replaced the app's own. Every
page with a body in the test dataset (65 pages) was converted both ways, and the results were
compared word by word.

The library loses five things that the app's turndown-based converter kept:

- the text of a status lozenge, such as an incident's severity (`SEV2`) or a service's `LIVE`;
- the title of an info, warning, note or tip panel;
- the title of an expand section;
- the name in a user mention, which becomes `[link]`;
- the separation between the cells of a nested table, whose text runs together.

It is better at four things: task lists keep each task and whether it is done, preformatted text
keeps its spacing, a macro it cannot convert is marked instead of dropped, and underscores are not
over-escaped.

The maintainer chose to use the library's converter now and to fix the five losses in the library
itself, rather than keeping the old converter or working around the library in this app. Each loss
is a test in `test/converter.test.ts` marked as expected to fail. When a library release fixes one,
its assertion starts to hold, the expected failure stops happening, and Vitest reports the test as
failed until the mark comes off. A fix therefore cannot arrive unnoticed. Every page's converted
Markdown is also kept as a snapshot, so any change in the library's output shows up as a diff to
review.

**Declined: a pre-pass in this app** that rewrites the affected macros before the library sees them.
It would fix the losses sooner, but it is XML handling done with regular expressions, owned here and
deleted later.

**The argument against:** the north star says the model must see what Confluence says, and until
the library is fixed it will not see a page's status lozenges or panel titles. That is true. It is
acceptable because nothing reaches a model before the AI features land in a later pull request, and
the fix belongs where every user of the library gets it.

---

## ADR-034 — The decision log is left out of the prose budget, as history and review are, and the budget for the live documents drops to 1,700 lines

**Status:** accepted, 2026-10-16. Amended by ADR-055. Amends ADR-031.

The prose budget (`MAX_DOC_LINES`) exists so that the documents a reader must keep up with stay a
size someone can read. It already leaves out `docs/history/` and `docs/review/`, because they are
append-only and cannot be shortened. The decision log is append-only for the same reason, and at
1,007 lines it had become most of what the budget measured, so the budget failed whenever a new
record was written, however short the live documents were.

The log is now left out of the count, and the limit is set for what remains:

| budget                       | limit       | measured when set |
| ---------------------------- | ----------- | ----------------- |
| live prose (`MAX_DOC_LINES`) | 1,700 lines | 1,464             |

**The argument against:** a document that is not counted can grow without anyone noticing. The log
is held instead by its own rules: one record per decision, a title that states it, and the tests in
`test/docs/prose.test.ts` that check its numbering, its status lines and every citation of it.

---

## ADR-035 — An exclusion covers everything below the excluded page, whichever rule matched, and a space's ZIP holds only pages that are not excluded

**Status:** accepted, 2026-10-16.

A rule that names a title or a path already excluded everything below the page, because the rules
compare against each ancestor's title. A rule that names a page by its id (`id:1234`) excluded the
page alone: the tree hid its children, but a child could still be read by its own id, and a sync
would write it to disk. An `id:` rule now matches the ids of a page's ancestors as well, so every
form of rule excludes a whole subtree, which is how the tree has always shown it.

A space's ZIP now holds the Markdown and attachments of the pages that are not excluded, with the
table of contents and the manifest, instead of the whole synced folder. The rules are applied when
the ZIP is built, because a rule saved without purging leaves the excluded pages' copies on disk.

**The argument against:** both change what an existing rules file or download does. That is the
intent: each closes a way for an excluded page to leave the machine, and the tests that hold it are
in `test/exclusions.test.ts` and `test/localCopy.test.ts`.

---

## ADR-036 — A dependency's install script does not run unless a record allows it

**Status:** accepted, 2026-10-16.

pnpm asks before running the install scripts that packages declare, and lists each package's choice
under `allowBuilds` in `pnpm-workspace.yaml`. An install script runs arbitrary code on every machine
that installs the project, including CI, so a script is allowed only when the package cannot work
without it, and that is recorded here.

The template's tooling already allows `esbuild`, `nx` and `unrs-resolver`, whose scripts install the
native binaries they are built on. The AI dependencies (ADR-017) brought two more, both denied:

- `@google/genai` declares a `preinstall` script that prints that it does nothing, and a `prepare`
  script that only runs when the package is developed from its own repository.
- `protobufjs` declares a `postinstall` script that installs the dependencies of its separate
  command-line tool, which this app does not use.

**The argument against:** denying a script that a package needs breaks it in a way that may only
show at run time. The tests that call the Gemini API through `@google/genai` (`test/ai.test.ts`)
pass with both scripts denied, and that is the evidence the denial is safe.

---

## ADR-037 — A question about a page sends the server's own copy of that page, never text the request supplies

**Status:** accepted, 2026-10-16. Amends ADR-018.

ADR-018 requires every page sent to an AI to pass the exclusion check first. `POST /api/ai/analyze`
checked the page a request named, but then sent the Markdown the request carried, so nothing tied
the text that left the machine to the page that was checked. Stale text from before a rule changed,
or another page's text sent under this page's id by a mistake in the browser, would have passed the
check.

When a request names a page, the server now sends its own copy of that page: the synced copy, or the
one read from Confluence, which is the copy the exclusion check itself reads. Text and a title in the
request are ignored. A request that names no page, such as a pasted snippet, is sent as given,
through the outbound guard like everything else.

**The argument against:** the browser runs on the same machine, the person using it can already read
the page, and the snippet route lets them send any text they paste. This does not stop someone who
means to send an excluded page. It is not meant to: the exclusion rules exist to stop pages leaving
by accident, and every case above is an accident. The test that holds it sends an excluded page's
text under a visible page's id (`test/aiRoutes.test.ts`).

---

## ADR-038 — The end-to-end workflow runs on every pull request, and fails rather than skips when Confluence did not start

**Status:** accepted, 2026-10-16. Amends ADR-011. Verified: the workflow's first run, on the fork,
started Confluence with docker, seeded it, and passed the suite. That run is also the first evidence
that ADR-011's docker path works.

The end-to-end suite runs in its own workflow, `.github/workflows/e2e.yml`, on every pull request
and on demand. It does not run on every push to a branch, as `test.yml` does. Starting Confluence
takes several minutes, and a pull request is the point where a change asks to be merged, so that is
where the evidence is needed. The maintainer chose this trigger, which design doc 0006 left open.

The job runs on Linux only, with docker, as ADR-011 describes; it uses `pnpm` and the template's
scripts rather than the `ci.yml` and `npm` commands ADR-011 names. It starts the test environment
with `pnpm run testenv:start`, then runs `pnpm run test:e2e`.

A developer without the test environment gets a suite that skips and says why (ADR-012). In CI that
would be a false pass: if Confluence failed to start, every test would skip and the job would still
succeed. The job therefore sets `E2E_REQUIRE_TESTENV`, and with it set, a missing environment fails
the suite instead of skipping it.

**The argument against:** running on pull requests only means a broken end-to-end path is found
later than it would be on every push. That is accepted, because a branch's pushes are work in
progress, and the fast suite, which does run on every push, covers the same code against the fake
Confluence.

---

## ADR-039 — Every merge to main publishes a beta, and a stable release is published only after the review packet for its version is answered

**Status:** accepted, 2026-10-16. Implements ADR-001's release gate; it does not amend it. The
stable-release half is superseded by ADR-044, and the beta half by ADR-045, so no part of it is
in force.

Releases come from `.github/workflows/release.yml`, which follows the release workflow of the
simply-atlassian repository: Lerna works out each version from the Conventional Commits since the
last release, writes the changelog, tags the version, creates a GitHub release, and publishes the
package to npm with provenance. The maintainer chose to follow that workflow so that the SimplySF
repositories release the same way.

ADR-001 requires a second person to answer the review packet for every load-bearing surface before
a release ships, and nobody has been named yet. The maintainer chose to allow betas in the
meantime, and to hold back stable releases only:

- **Every merge to `main` publishes a beta**, versioned as a prerelease such as `0.1.0-beta.0` and
  published under npm's `beta` dist-tag. A beta is for the team trying the app against its own
  Confluence, and the README says to install it with `@beta`.
- **A stable release is started by hand**, from the workflow's `stable` input. The workflow first
  works out the version the current beta would graduate to, without committing, tagging or pushing,
  and runs `node scripts/release-gate.mjs <version>`. The gate fails unless `docs/review/<version>.md`
  says it is answered, names its second reviewer, and answers every surface in the load-bearing
  surfaces table in `AGENTS.md`. Only then is the version tagged and published as `latest`.

The gate reads the surface names from `AGENTS.md` rather than keeping its own list, so adding a
surface to the table adds a question every later packet must answer. `docs/review/TEMPLATE.md` holds
the same names as headings, and `test/releaseGate.test.ts` checks that the two agree. The gate is
itself listed under "The enforcement itself", since switching it off would switch off ADR-001.

The workflow's `prerelease/**` branch trigger, which simply-atlassian has, is left out: `main`
already produces a beta on every merge, so a separate prerelease branch would have no job.

One exception is not settled yet. npm's registry gives every package a `latest` tag, and may give
it to a new package's very first version whatever tag that version was published under. If it does,
a plain install gets `0.1.0-beta.0` until the first stable release moves `latest`, and later betas
do not. The first publish will show which, and this record's status line will say.

**What the gate cannot check:** it reads a document. It cannot tell whether the person named in it
did the review, or did it independently. That remains a matter of trust between the maintainer and
the reviewer, which is why a packet is committed through a pull request the maintainer reviews.

**The argument against:** a beta on npm is public and permanent. Anyone can install it, and a
version number, once published, can never be used again, even if the version is withdrawn. ADR-001
blocks releases because this app writes to pages other people read, and a beta can do that too.
This is accepted for three reasons. The `beta` tag keeps betas away from a plain install, apart
from the first-version exception above. The README states plainly that there is no stable release
yet, and why. And the alternative, handing the team an untracked tarball, gives them the same code
with no version, no changelog and no provenance.

---

## ADR-040 — simply-atlassian-core 0.7.2 is installed on the day it was released, as a named exception to pnpm's one-day release age

**Status:** accepted, 2026-10-16.

pnpm refuses to install a package version that is less than a day old. The delay protects against a
hijacked release: a malicious version is usually noticed and withdrawn within hours, so a project
that waits a day rarely installs one.

`@simplysf/simply-atlassian-core` 0.7.2 was published on 2026-10-16 and carries the library fix for
the five conversion losses recorded in ADR-033. The maintainer chose to adopt it the same day rather
than wait, so that the first beta (ADR-039) converts pages without those losses. The maintainer
knows the SimplySF team that publishes the library, and the fix in it was written for this project
(simply-atlassian pull request 55).

The exception is the `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml`. It names one
version, not the package, so any later version of the library still waits the full day, and the
entry stops mattering once 0.7.2 is a day old.

**The argument against:** an exception made because the publisher is trusted is exactly the
exception a hijacked publisher account would exploit. The delay exists for the case where the
people are trustworthy but their account is not. The converter tests and their snapshots show that
the library's output changed only in the five places the fix intended, but that checks behaviour on
the test dataset; it does not show the package holds nothing else. The risk is accepted for one
version, released by a team the maintainer knows, and is not a precedent: a later exception needs
its own record.

---

## ADR-041 — A page that holds parts Markdown cannot carry is never written from Markdown; the write is refused instead of losing them

**Status:** accepted, 2026-10-16. Amends ADR-024. Amended by ADR-058.

The app edits pages as Markdown. Converting a page to Markdown turns the parts Markdown has no form
for into placeholder text: an image becomes `[image: chart.png]`, a macro becomes `[macro: jira]` or
`[status: LIVE]`, a link to another page becomes its bare title, and a panel becomes a quoted
paragraph. A push replaces the whole body of the page with the proposal converted back from
Markdown, so every one of those parts was replaced by its placeholder text in Confluence. The dry run
passed and the confirmation dialog gave no warning. This was found while capturing screenshots for
the documentation, when pushing a proposal for a test page replaced its embedded image with the text
`[image: capacity-chart.png]`.

The write path now refuses such a page. Before a dry run or a push, it converts the page as
Confluence holds it to Markdown and back, and compares the two: each image, macro, link to another
page, mention, task list and layout present before and missing after is counted and named in the
refusal, and nothing is written. The comparison is done on the converter's real output rather than
on a fixed list of forbidden parts, so a part the converter learns to carry stops being refused
without a change here. Code blocks, which the converter does carry, are not refused.

The check sits in `writePage`, the one function that changes an existing page (ADR-024), so the
single-page push, the branch queue and both of their dry runs are covered by it. A new page has no
existing body to lose and is not affected. An append, which the app's interface does not offer, adds
to the body without replacing it and is not checked.

**Declined: keeping the original parts and writing only the text around them.** That would let such
pages be improved, but it needs a way to match each placeholder in the proposal back to the part it
came from after an AI has rewritten the page, and to decide what to do when the AI moved, changed or
removed a placeholder. It is a larger piece of work, belongs partly in the converter library, and is
not attempted here.

**The argument against:** most real pages hold at least one macro or link, so Improve now refuses
most of them, and the feature is far less useful than it looked. That is accepted, because the
alternative is a feature that quietly damages the pages it touches, and the refusal says exactly why
so the person can make the change in Confluence instead.

---

## ADR-042 — The user guides ship inside the package and have a prose budget of their own, instead of raising the budget for the project's documents

**Status:** accepted, 2026-10-16.

The app's user documentation lives in `packages/simply-confluence-explorer/docs/`: a getting-started
page, a guide to each part of the app, and the screenshots they show. It follows the other SimplySF
repositories, whose guides ship inside each package so that the combined documentation site at
`simplysf.github.io/simply-cli` can build its pages from the package as published. The package's
`files` list therefore includes `/docs`. The maintainer chose this home for the documentation over a
GitHub wiki, which no other SimplySF repository uses and which would not be versioned with the code.

The guides are written for people using the app, and they are long by nature: one guide per feature,
each explaining what to do and what to expect. Counting them under `MAX_DOC_LINES`, the budget for the
documents a person working on the project must keep up with (ADR-034), would have meant raising that
budget by half, and it would then no longer notice the project's own documents growing. The guides are
counted separately instead:

| budget                          | limit       | measured when set |
| ------------------------------- | ----------- | ----------------- |
| user guides (`MAX_GUIDE_LINES`) | 1,100 lines | 896               |
| project prose (`MAX_DOC_LINES`) | 1,700 lines | 1,585 (unchanged) |

The screenshots are captured from the test environment's generic dataset (ADR-007), so no real space
or page appears in them. They are WebP images, about 1 MB together, which the package now carries.

**The argument against:** a separate budget is a second place for prose to grow. That is accepted
because the two kinds of document grow for different reasons: a guide grows when the app gains a
feature, and the limit is set with room for that, while the project's documents should not grow at
all without a reason.

---

## ADR-043 — The documentation is a site of this repository's own on GitHub Pages, instead of a section of the shared simply-cli site

**Status:** accepted, 2026-10-16. Amends ADR-042.

ADR-042 put the user guides in the package so that the combined SimplySF site at
`simplysf.github.io/simply-cli` could build pages for the app from the published tarball. The owner of
that site preferred a separate documentation site for each product, and Confluence Explorer is its own
product rather than a plugin of the `simply` command. The pull request that would have added it to
the shared site was closed, and the documentation is now a site of this repository's own, at
`https://simplysf.github.io/simply-confluence-explorer/`.

The site is a Starlight site in `site/`, built the way simply-atlassian's own site was before it
moved to the shared one: the SimplySF logo, a landing page, and `.github/workflows/docs.yml`, which
builds the site, checks every internal link, and deploys it to GitHub Pages from `main`. The guides
stay where ADR-042 put them, in `packages/simply-confluence-explorer/docs/`, and the site copies that
folder in on every build (`site/scripts/sync-docs.mjs`). They are written once, read on GitHub as they
are, and checked by the package's tests.

The site builds from `main` rather than from the published package. The reason the shared site
used the package was that `main` can describe commands a reader does not have yet; here every merge
to `main` publishes a beta (ADR-039), so `main` and the newest beta describe the same app.

Two things change from ADR-042:

- **The package no longer ships `/docs`.** The guides were in the tarball only so the shared site
  could read them there. Leaving them out keeps about 1 MB of screenshots out of every install.
- **The site's dependencies have a budget of their own**, `MAX_SITE_DEPS`, set at the four the site
  needs: `astro`, `@astrojs/starlight`, `@astrojs/markdown-remark` and `sharp`, at the versions
  simply-cli's site already uses. They are not counted under `MAX_RUNTIME_DEPS` or `MAX_DEV_DEPS`,
  because the site is never published and none of its code reaches a person running the app. Before
  this record the budget script did not read `site/package.json` at all.

| budget                              | limit | measured when set |
| ----------------------------------- | ----- | ----------------- |
| site dependencies (`MAX_SITE_DEPS`) | 4     | 4                 |

The link checker and the tool that waits for the preview server are run with `npx` at pinned
versions in the workflow, so they add nothing to any manifest.

**The argument against:** a second site means a second place for SimplySF's documentation to look
different and a second workflow to maintain, which is what the shared site was built to avoid. That is
accepted because the owner of the shared site asked for this, and because the site follows the same
template, logo and theme as the other SimplySF sites.

---

## ADR-044 — A stable release is published when a second person approves its release pull request, instead of answering a written review packet

**Status:** accepted, 2026-10-19. Amended by ADR-053. Amends ADR-001 and supersedes the stable-release half of ADR-039.

ADR-039 held back stable releases until a second reviewer had written an answer for each
load-bearing surface into `docs/review/<version>.md`. The maintainer replaced that with a review the
team already knows how to do: a pull request.

- **A stable release starts as a pull request.** Running `release.yml` by hand with **stable**
  ticked works out the version the current beta graduates to, writes it and its changelog on a
  branch named `release/<version>`, and opens a pull request for it. The pull request's description
  lists the load-bearing surfaces, read from the table in `AGENTS.md`, so the reviewer knows which
  parts of the code carry the risk.
- **A second person approves it.** The approval must come from someone other than the person who
  opened the pull request, and must be for the pull request's last commit, so a change pushed after
  the approval is not covered by it.
- **Merging it publishes the release.** When a merge to `main` leaves a stable version that npm does
  not have yet, the workflow runs `scripts/release-gate.mjs`, which reads the merged pull request
  and its reviews from GitHub and fails unless the conditions above hold. Only then is the version
  tagged and published as `latest`, so a plain `npx @simplysf/simply-confluence-explorer` installs it.
  The same check runs before a stable version is published by hand, so the manual publish is not a
  way around it.

Every other merge to `main` still publishes a beta under the `beta` tag, as ADR-039 describes.

**The argument against:** this project follows the agent-led development standard at stakes `real`
(ADR-001), and that standard (§7.5) asks for more than an approval. It asks the reviewer to write
answers for every load-bearing surface into the release's review packet, and for CI to refuse the
release until they are there. An approval is one click; it shows that a second person accepted the
release, not what they read or what they found. By this decision the project no longer meets §7.5,
and says so here rather than lowering its declared stakes, which ADR-001 refused to do. The
maintainer accepted this because the reviewer is a member of the team who reviews SimplySF's other
releases the same way, and a written packet asked the reviewer to repeat in a document what a pull
request review already records. `docs/review/` stays, for any written review a release does get.

---

## ADR-045 — A merge to main publishes nothing; only an approved release pull request publishes, and there are no betas

**Status:** accepted, 2026-10-19. Supersedes the beta half of ADR-039.

ADR-039 published a beta to npm on every merge to `main`, because no second reviewer had been named
and stable releases were blocked; betas let the team try the app in the meantime. A reviewer has
since been named, 0.1.0 has shipped as a stable release (ADR-044), and the maintainer decided the
betas no longer serve a purpose.

`release.yml` now publishes only when a merge to `main` leaves a stable version that npm does not
have yet, which only a release pull request does, and only after `scripts/release-gate.mjs` has
found it approved. Every other merge runs the build and tests and stops. A release pull request
takes its version from the commits since the last release (`lerna version --conventional-commits`),
since there is no beta to graduate. The install instructions name no tag, because `latest` is the
only one.

**The argument against:** without betas, nobody outside the repository can try a change before it
is in a stable release, so the first time a change meets other people's Confluence is in a version
a plain `npx` installs. That is accepted because a release now gets a second person's review and
the end-to-end suite runs against a real Confluence on every pull request, and because in practice
no beta was ever tried: the eight that were versioned never reached npm. Someone who wants to try `main` can still
build and run it from a checkout.

---

## ADR-046 — Every improvement starts from a review whose suggestions the person chooses, and a page, a section and a tag are reviewed by the same flow

**Status:** accepted, 2026-10-19. Amends ADR-024 and ADR-026. Amended by ADR-049.

Before this record the app had three ways to improve pages, each with its own shape. The Improve tab
asked for a focus, one of four, and returned a whole rewritten page. "Work on branch" could review a
page and everything under it, but its findings could only be read, and its "Improve every page"
rewrote every page with the same focus. The maintainer found that what they wanted was the review:
a list of what is wrong, from which they pick what to fix.

- **One flow.** A review works on a set of pages, chosen in one of three ways: one page (the Improve
  tab), a page and everything under it, which the app now calls a **section** because "branch" read
  as source control, or the pages that carry a **tag**. The person ticks the pages and the aspects to
  look for (accuracy, repetition, staleness, clarity, depth, structure, runbooks), adds any context,
  and gets suggestions, each with a tick box. **Apply selected** asks the AI for an edit of each page
  the ticked suggestions name, carrying only those suggestions. The edits then go through the queue
  ADR-024 describes, unchanged: accept, edit or reject each page, check, then push.
- **One run.** On the server every review is a run in `data/branch-runs/` holding the ids of the
  pages it read. The browser sends only page ids and suggestion numbers. The server checks each page
  against the exclusion rules and the secrets check, and that a section's pages are inside it and a
  tag's pages carry it.
- **Removed:** "Improve every page", and the Improve tab's four focuses and whole-page rewrite. A
  suggestion that needs a page moved, split, merged or written is shown but cannot be applied,
  because no edit of an existing page does it.
- **Layout (amends ADR-026).** "Work on branch" becomes "Review section". The sidebar gains a switch
  between the page tree and a list of tags, and a **Space chat** for questions about the whole space,
  with its saved conversations. Ask AI on a page asks about the page or its sub-pages, starting with
  the sub-pages, and no longer about the whole space. The header shows work that is running in the
  background, such as a sync, AI summaries or a review, and opens it when clicked.

**The argument against:** a rewrite with a focus could make changes nobody thought to ask for, and a
review only finds what it is asked to look for. That is accepted because the aspects all start
ticked, the person can add their own instructions, and a change the person did not choose is
exactly what ADR-024 exists to prevent.

---

## ADR-047 — A request to an AI can be stopped while it is in progress, and a stopped request leaves nothing behind

**Status:** accepted, 2026-10-19. Amends ADR-024, which deferred cancelling a request in progress.

Every chat (Ask AI, Space chat and the new-page writer) and every review has a **Stop** button while
the AI is answering. Stopping aborts the browser's request; the server passes the abort to the
provider's SDK or ends the Gemini CLI process, records `stopped` in the AI audit log, and discards a
reply that arrives afterwards, so a conversation never gains half a turn and a review never gains
findings after it was stopped. In a chat the question goes back into the box, so the person can
correct it and send it again.

**The argument against:** a stopped request may already have reached the provider, which may still
bill for it and keep it under its own retention rules. Stopping therefore cannot undo a send, and
the audit log records the request as sent and stopped rather than as never sent.

---

## ADR-048 — A whole-space question first asks the AI which pages to read, from their summaries alone, instead of sending the top search results

**Status:** accepted, 2026-10-19. Amended by ADR-051. Amends ADR-023, which sent the best-matching pages for each question.

A question about a whole space is answered in three steps (`src/spaces/contextRetriever.ts`).
The BM25 index finds up to 25 candidate pages for the question, the question before it and the
conversation so far. One small request then shows the AI those candidates by their metadata only,
which is the title, place in the tree, AI summary, tags, document type and systems named, and asks
which of them to read and why. Their full text, with the pages earlier answers used, then fills the
context up to its limit. Each answer records the pages it read, with the reason, and how many it
looked at. With no summaries, or a choice that cannot be read, the top search results are read.

**The argument against:** every whole-space question costs a second request, and sends the AI the
titles and summaries of up to 25 pages that may not be read in full. That is accepted because the
summaries are already derived from pages the exclusion rules allow, they pass the outbound guard
like everything else, and the person asking in an unfamiliar space (an incident at night, say) is
exactly who cannot judge which pages to pin; a keyword search alone missed pages that summaries
describe well.

---

## ADR-049 — Pages are changed from a chat's suggestions; the Improve tab and the separate review flow are removed

**Status:** accepted, 2026-10-19. Amended by ADR-051 and ADR-060. Amends ADR-046 and ADR-026.

A chat reads a page, a directory (a page and everything under it), chosen pages such as those of
one or more tags, or the whole space. Any answer can become suggestions with tick boxes: the chat's
**Review for problems** and **Suggest improvements** actions ask for them, and **Turn this
conversation into changes** turns what was discussed into them. The suggestions are stored with the
turn on the server. **Queue selected** stages an edit of each page the ticked suggestions name,
carrying only those suggestions, and the queue is reviewed and pushed as ADR-024 describes. The page
has three tabs, Read, Chat and Details; the Improve tab, the Review section dialog and starting a
review run outside a chat are removed.

**The argument against:** a chat is less structured than a form, so a person may not find the
review at all. That is accepted because the review is offered as a button in every chat that reads
more than one page, and because the maintainer's own work (finding repeated pages across a space,
fixing a drifted directory) starts as a conversation and only later becomes a list of changes.

---

## ADR-050 — The app reads GitLab repositories for new pages, through a connection the server holds, and only on the configured GitLab

**Status:** accepted, 2026-10-19.

A new page can be written from a GitLab repository: the person pastes its link, and the server reads
its file list, README, Markdown docs, API description files and package manifest, within fixed
limits on files and characters (`src/gitlab/client.ts`). The GitLab address and a personal access
token are saved under **Settings → GitLab**, stored like the Confluence token and never returned to
a browser. As with Confluence (ADR-019), a link on any other host is refused, so a web page cannot
make the server fetch from a place of its choosing. The client uses Node's built-in `fetch`, so no
dependency is added. What it reads is not Confluence content, so the exclusion rules do not apply;
it passes the outbound guard like an uploaded file.

**The argument against:** this is a second outbound connection and a second stored credential, and
repository text may hold secrets. That is accepted because the token can be read-only, the host is
fixed, and the outbound guard stops a request that carries a secret; both are added to the
load-bearing table in `AGENTS.md`.

---

## ADR-051 — A chat chooses a corpus of any size and each question retrieves sections from it, instead of sending chosen pages in full

**Status:** accepted, 2026-10-19. Amends ADR-048, which chose whole pages for a whole-space
question, and ADR-049, which capped chosen pages at 50.

What a chat reads is a **corpus**: a page, a directory with everything under it, any mix of
directories, tags and single pages, or the whole space. A corpus has no size limit. When all of it
fits in one request it is sent in full, as before. When it does not, each question retrieves from
it (`src/spaces/contextRetriever.ts`):

1. Pages are split into **sections** at their headings (`src/spaces/sections.ts`), and the BM25
   index searches sections rather than whole pages.
2. **Metadata version 2** adds, for each page, a one-line summary of each section, the questions the
   page answers and its audience. Its topics are chosen from the space's existing topics where one
   fits, so pages on one subject share a tag. Metadata older than its page is regenerated by the
   same background job, which can be stopped and resumed.
3. When the AI provider offers **embeddings** (OpenAI and Gemini do; Claude does not), each
   section's text is embedded through the outbound guard and stored beside the synced copy. A
   question is then matched by meaning as well as by its words. Without embeddings, retrieval uses
   the keyword index and the metadata alone.
4. The best 40 sections are shown to the AI by title, place, heading and section summary, never by
   their text, and it picks up to 12. Those sections are sent in full, with the ones earlier answers
   used. Each answer names the sections it read and why.

A review or a request for changes over a corpus too large for one request runs as a background
job. It reviews the pages in batches, grouped by shared topics so related pages are compared
together, and merges the findings into one list of suggestions.

**The argument against:** embeddings send every section of the space to a provider once, not only
the sections a question needs, and a retrieved answer can miss a section a full read would have
seen. That is accepted because embeddings are only made when the person has chosen a provider that
offers them, each request passes the outbound guard and the audit log as every other request does,
a section holding a secret is never embedded, and the data-safety guide says what is sent. A corpus
that fits is still read in full, so retrieval is used only where a full read is impossible.

---

## ADR-052 — The Snippet parser is removed, because converting pasted storage format is not part of exploring, asking about or changing pages

**Status:** accepted, 2026-10-19.

The header's **Snippet parser** converted a piece of Confluence storage format, pasted in by hand,
to Markdown, through `POST /api/parse`. It came with the app's first version as a way to see the
converter at work. Nothing in syncing, chatting, changing pages or writing new ones uses it, and a
page's own Markdown is shown on its Details tab, so it is removed with its route, test, guide
section and screenshot. The converter itself stays: every other part of the app depends on it.

**The argument against:** someone checking how a macro converts loses a quick way to do it. That is
accepted because the Details tab shows how each real page converts, which is the case that matters,
and the header is clearer with one button fewer.

---

## ADR-053 — Before 1.0, a release pull request merged by a maintainer is published without a second approval

**Status:** accepted, 2026-10-20. Amends ADR-044, for versions below 1.0.0 only.

The app is in rapid development, and waiting for a second person held back a finished release.
The release workflow opens release pull requests under the maintainer's own account, so GitHub does
not let the maintainer approve them. The maintainer chose to be able to release alone until the
first major version.

- **Below 1.0.0**, `scripts/release-gate.mjs` lets a release through when its pull request came from
  `release/<version>` and was merged by a maintainer, with or without an approval. Maintainers are
  listed by their GitHub login in the repository variable `RELEASE_MAINTAINERS`, which the release
  workflow passes to the gate. The list lives in the repository's settings, not in its files, so no
  account name is written into this public repository.
- **From 1.0.0**, the exception ends without any change to the code: ADR-044's approval by someone
  other than the pull request's author is required again.
- **A request for changes still stops a release**, whoever merges it.

**The argument against:** a second reviewer is the only human check on code that writes to
Confluence and sends pages to AI providers, and ADR-001 declared stakes `real` because a team depends
on the app. Releases below 1.0 that a maintainer merges alone are reviewed by nobody but their
author. That is accepted for now because the maintainer reviews every pull request before merging
it, every change to a load-bearing surface is still flagged in its pull request, and the release
pull request still lists those surfaces for anyone who wants to read them. The project does not lower
its declared stakes; it records this as a time-limited exception that ends at 1.0.0.

---

## ADR-054 — Large spaces are indexed in packs of pages, context is checked on its way to the model, and the app keeps its own traces instead of console lines

**Status:** accepted, 2026-10-20. Amended by ADR-063, which reports a freeze only when the server was blocked.

The space the app was built for has about 3,200 pages and uses the Gemini CLI, which has no
embeddings and starts a process for every request. Measured on a generated space of that size, the
server's own work took under a second per action, but indexing meant 3,200 requests in a row, a
question read at most 12 sections, failures were only counted, and server messages were lost when
the console closed. Design doc 0008 describes the changes; these are the decisions behind them.

- **Indexing sends several pages per request** and runs a few requests at once (2 for the Gemini CLI,
  4 for API providers, set in Settings). Every page sent must come back in the reply; one that does
  not is retried on its own, then recorded as a failure with its reason.
- **Every request carries a context manifest**: what was meant to be sent, what was included, and why
  anything was left out. The engine checks the manifest against the guarded payload before sending
  and refuses a request whose included items are missing from it. An answer cut short by the
  model's output limit, or blocked, is reported as such.
- **A broad question can be answered thoroughly**, as a background job that reads many sections in
  batches and combines their notes, on the machinery of batched reviews (ADR-051).
- **The app records traces, logs and a few health numbers** in `<data dir>/telemetry/`, kept 14 days
  and capped at 200 MB, and shows them on an Observability page. They hold counts, ids, durations,
  titles of allowed pages and error messages, and never page text, prompts, answers, credentials or
  the title of an excluded page; a test checks this.

**The argument against:** packing pages lets one bad reply affect several pages, the manifest check
can refuse a request that would have worked, and telemetry is a new store of data about the user's
work on disk. These are accepted because every packed page is accounted for and retried alone, a
refused request is a bug the check found rather than context silently lost, and the telemetry stays
on this machine under the same rule as the synced pages: nothing excluded is named in it.

---

## ADR-055 — The prose budget rises to 1,850 lines for design doc 0008

**Status:** accepted, 2026-10-20. Amends ADR-034. Amended by ADR-062, which raises the prose budget to 1,950 lines.

New features start as a design doc (AGENTS.md), and the work in ADR-054 is a new feature: indexing
large spaces, thorough answers, context checks and an Observability page. The live documents stood
at 1,699 of 1,700 lines, so the design doc could not be written without removing text from other
documents that still describe how the app works. The limit rises to 1,850, enough for design doc
0008 and the guide changes that point to it.

**The argument against:** the budget exists to keep the documents a size someone can read, and
raising it whenever it is reached makes it no limit at all. This is accepted because the increase is
sized to one design doc, which the project's own rule requires, and the next increase needs its own
record arguing for it.

---

## ADR-056 — A question is not expanded with the space's topics; words that mean the same come from embeddings instead

**Status:** accepted, 2026-10-20.

The plan for design doc 0008 included topic expansion: matching a question's words to the space's
topics from the AI index, and adding the pages that carry those topics as candidates. It was
declined once the retrieval measurement (`test/retrievalEval.test.ts`) was in place. Topics already
count in the section search, and their words are stemmed in the same way as the question's, so a
question that shares a word with a topic already finds that topic's pages. What expansion would add
is a match between different words that mean the same thing, such as "down" and "outage". Matching
those needs embeddings, so the embedding provider was made separate from the chat provider instead.
A Gemini CLI user can then add a Gemini or OpenAI key for embeddings alone.

**The argument against:** a user with no embedding key gets no match on meaning at all. That is
accepted because a table of synonyms kept by the app would be a guess about every team's vocabulary,
and the weak-match warning tells the user when a search found little.

---

## ADR-057 — Timing checks on large spaces run on a real machine, not in CI

**Status:** accepted, 2026-10-20.

Design doc 0008 promises that the server keeps answering while a 3,200-page space is indexed. The
test for it timed health checks during the walk and failed on any wait of 250 ms or more. In CI it
failed on the Windows runners again and again after the code that held the server had been fixed.
Each failing wait was recorded with the CPU time the test's process used in it, and the longest
waits used a third of their time or less: the runner, sharing two cores among some forty test
files, was not giving the process a turn. On a real machine, pinned to a single core, the longest
wait was under 75 ms.

- **The fast suite keeps what does not depend on timing.** `test/largeSpace.test.ts` indexes the
  generated space and fails if a page is left out, if indexing takes more than one request per five
  pages, or if a question about the space is not answered.
- **The timing moves to a scale check** in `test/scale/`, run with `pnpm run test:scale`. It is run
  on a real machine after changing code that reads a whole space, and the result is reported in the
  pull request.

**The argument against:** with the timing out of CI, a change that brings back a freeze is caught
only if someone runs the scale check. This is accepted because a check that fails at random teaches
people to ignore it, which is worse; the code that reads whole spaces goes through `mapChunked` in
`src/util/pause.ts`, and the scale check is named in AGENTS.md beside the other suites.

---

## ADR-058 — A page that holds parts Markdown cannot carry is changed through markers that keep each part exactly, instead of being refused

**Status:** accepted, 2026-10-20. Amends ADR-041.

ADR-041 refused any change to a page holding an image, a macro, a link to another page, a mention,
a task list or a layout, because a push replaced the whole body with storage converted from
Markdown, and each of those parts would have become text. Most real pages hold at least one, often
a table of contents, so most pages could not be changed at all. ADR-041 named the fix and deferred
it; this record makes it.

A page is now edited through its **edit form** (`src/parser/editForm.ts`, design doc 0009):

- **Each part Markdown has no form for becomes a numbered marker** in the text, such as `⟦1 toc⟧`
  or `⟦4 status: LIVE⟧`, and its storage is kept on the server. A panel, an expand section or a
  layout column becomes a pair of markers around its text, so that text can still be edited. A
  block whose text cannot be written back without changing it, such as a table with merged cells,
  becomes one marker and is kept exactly as it is.
- **A push builds the storage from the edit form.** A block the change leaves alone is written as
  Confluence holds it, byte for byte. A changed block is converted from Markdown, and each marker
  is replaced by the part it stands for.
- **The model is told to keep every marker**, and it may move or remove one only when a suggestion
  asks for it. A marker the page does not have, a marker used twice, and a container's markers out
  of order each refuse the write and are named.
- **Nothing is lost without a decision.** Every part of the page must be in what is written, unless
  the person accepted a change that removes it (ADR-059). As a backstop, the write counts each kind
  of part in the page and in what it is about to send, and refuses the write if any are missing.
  That count now also covers the parts the old check missed: links to anchors and attachments,
  emoticons, inline comments, extensions and dates.

The single-page push route has no review of changes, so a part missing from its text is refused
there, as before, with the marker that names it.

**The argument against:** the edit form is the app's own format, and a model may mangle a marker or
put one where its part does not belong. That is accepted because every such mistake is caught
before anything is written: an unknown or repeated marker is refused, a marker put inside code is
counted as missing, and the person sees each change, including any removal, before accepting it.

---

## ADR-059 — An edit is reviewed change by change, keeps the AI's version to reset to, and is checked as part of the push

**Status:** accepted, 2026-10-20. Amends ADR-024. Amended by ADR-060, which adds staging and the chat's revisions of an open edit.

A page's edit was accepted or rejected as a whole, even when it carried several suggestions. A
person's own edits replaced the AI's version, so it could not be restored, and edits made in the
editor were lost on switching to another view. Rejecting did nothing visible, and the dry run was a
separate step whose failures dropped silently out of the push count.

- **Each change is decided on its own.** A change is a run of blocks in which the working text
  differs from the page; a rewritten paragraph is one change, and removing a part, such as a macro,
  is a change of its own, labelled with what it removes (`src/branches/pageChanges.ts`). A push
  writes the page with only the accepted changes, so a rejected or undecided change leaves that part
  of the page exactly as it is.
- **The AI's edit is kept** beside the working text. The person's edits are saved as they type and
  show as changes of their own, and **Reset to the AI's edit** puts the text back and clears every
  decision. A decision is kept by the change's content, so it survives an edit elsewhere, and a
  change the person edits is asked about again.
- **The check is part of the push.** **Check and push** checks every page that has accepted
  changes, then lists the pages that will be written and the ones that failed, with why. A page
  that changed in Confluence since its edit was made can be made again from the current page.

**Declined: deciding each suggestion rather than each change.** The model applies a page's
suggestions in one rewrite, so the text alone does not say which words came from which suggestion.
Asking the model to apply each suggestion separately would cost a request per suggestion and could
not show how they combine. A change is what the person can see and judge, so it is the unit of
decision.

**The argument against:** a page with many small changes asks for many decisions. That is accepted
because **Accept all** and **Reject all** decide a page at once, and the north star requires that a
person reads what changes before it is written.

---

## ADR-060 — Each chat owns its suggestions and edits as queues, and the chat itself changes them

**Status:** accepted, 2026-10-21. Amends ADR-049 and ADR-059.

A chat's suggestions were tick boxes on the answer that made them, and the edits queued from them
were reviewed inline below that answer. With several answers, the suggestions, edits and pushes of
one piece of work were spread down a long conversation, and the chat could not change a suggestion
it had made: a better wording meant a new review and a new list.

- **A chat keeps one review queue** (`src/ai/chatQueue.ts`, stored with the conversation). Every
  suggestion an answer makes is added to it, and the answer says how many with a link to the queue.
  An older chat's suggestions move into its queue the first time it is read.
- **The chat changes its queue when asked.** Each question carries the queue's suggestions by id,
  and the answer may end with a block that adds, rewords or removes them, which the server applies.
  A reworded suggestion keeps its earlier wordings, and the person can go back to one; a suggestion
  the chat removed can be brought back. An edit made from an earlier wording says so.
- **The queues are tabs of the chat:** Chat, Review, Changes and Push, with the question box under
  every tab. Review lists the suggestions with their state; Changes holds the edits, each shown with
  the page and the edit side by side and decided change by change (ADR-059); Push holds the pages the
  person staged. A space's staged pages can also be pushed together from **Ready to push**.
- **The chat revises an open edit.** While an edit is open, a question is about that edit: its page
  is checked against the exclusion rules and sent with the edit on that turn, and the answer may
  propose a complete revised text, which the person accepts into the edit or dismisses.
- **A page is staged before it is pushed.** Staging needs every change decided and at least one
  accepted; any later change to the edit unstages it, so what is pushed is what the person looked
  at. A push writes only the staged pages it names.

Design doc 0007 declined "a separate review screen beside chat" because it split one piece of work
across two places and could not choose a directory's or a tag's pages. These queues are not a
separate screen: they are the chat's own tabs, and the chat still chooses what it reads. The
maintainer asked for this change, and it reverses that refusal.

**The argument against:** letting the model rewrite the suggestions the person is about to act on
means the list can change under them. That is accepted because every change is shown on the answer
that made it, an earlier wording is never lost, and nothing reaches Confluence until the person has
decided each change of an edit, staged the page and confirmed the push.

---

## ADR-061 — An edit is made from the page as Confluence holds it now, and a suggestion made before the page changed is checked again first

**Status:** accepted, 2026-10-21. Amends ADR-024.

An edit was made from the copy of the page on this machine. When someone had changed the page in
Confluence since the last sync, the edit was built on old text, and the push was refused only at the
end, after the person had decided every change.

- **Each page is read from Confluence before its edit is made.** A page newer than the copy on this
  machine replaces that copy, and the page is checked against the exclusion rules again; one now
  excluded is left out.
- **A suggestion made before the page changed is checked again.** A suggestion records the version
  of each page it names. When the page has moved on, one guarded request asks whether each such
  suggestion still applies, is already done, or no longer makes sense, given the page now and what
  changed since. Only those that still apply are put into the edit; the others return to the review
  queue with the reason, and a page with nothing left to change is not edited.
- **The push still refuses** a page that changed after its edit was made (ADR-024), which now only
  happens when someone edits the page in the minutes between the edit and the push.

**The argument against:** the check costs a request for each changed page, and the model may judge a
suggestion done when it is not. That is accepted because the request is made only for a page that
changed, and a suggestion judged done or not relevant is shown with the reason and can be
recommended again.

---

## ADR-062 — The code budget rises to 16,500 lines and the prose budget to 1,950 lines for the chat's queues

**Status:** accepted, 2026-10-21. Amends ADR-021 and ADR-055.

The chat's queues (ADR-060) and the fresh read before an edit (ADR-061) are a new feature: a review
queue the chat can change, an edit view with the page and the edit side by side, staging, a push
queue, and a revision of an open edit through the chat. With the inline queue removed, the code
stood at 16,008 of 15,000 lines. The limit rises to 16,500, which keeps the usual small headroom.
The live documents stood at 1,848 of 1,850 lines, and the feature needs design doc 0010, so that
limit rises to 1,950.

**The argument against:** raising a budget each time it is reached makes it no limit. This is
accepted because each increase is sized to the measured feature, and the next one needs its own
record.

---

## ADR-063 — A freeze is reported only when the server was blocked for over two seconds, once per freeze, not whenever a timer ran late

**Status:** accepted, 2026-10-21. Amends ADR-054.

The Observability page raised "The server could not answer anything for 1.x s" many times a day.
The check behind it raised a problem whenever a 5-second check ran more than a second late, for any
reason. On macOS a process in the background has its timers held back to save power, and a laptop
waking from sleep runs them late too, so most of those problems described the operating system, not
the app. Each late check also added a problem of its own, so one slow spell filled the list.

- **A freeze is the server blocked by its own work.** A check that ran more than 2 seconds late
  counts only when Node's event loop was busy for at least 80% of the wait, which separates work
  that held the server from a timer the system delayed. Shorter waits are still recorded, as the
  `lagMaxMs` number on the Now view.
- **One problem per freeze.** Checks in a row that found the server blocked are counted into one
  problem, "for up to 2.4 s, 3 times between 10:02 and 10:03", written once the server answers
  again.
- **The Logs view no longer causes freezes of its own.** Records are read from the end of each
  day's file, a piece at a time, so a view that stops after the newest records no longer reads a
  whole large day while the server waits.

**The argument against:** a real freeze of between one and two seconds is no longer reported as a
problem. That is accepted because such a wait is still visible as a number on the Now view, and a
problem should mean something a person needs to act on.
