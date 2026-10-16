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

**Status:** accepted, 2026-10-15.

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

**Status:** accepted, 2026-10-15.

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

**Status:** accepted, 2026-10-15.

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

**Status:** accepted, 2026-10-15.

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
the ZIP in the Space menu, rather than as buttons beside them.

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
