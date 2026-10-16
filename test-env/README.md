# Confluence Data Center test environment

This directory runs a real Confluence Data Center 9.2 on your machine, for the end-to-end tests. It
uses Postgres 15 and Confluence in containers, under podman or docker. It sets Confluence up
automatically and fills it with a fixed test dataset, so the tests always run against the same
spaces and pages.

A real Confluence is used rather than a fake of its REST API, because a fake would behave however the
code already assumed Confluence behaves, and so could never catch a wrong assumption (ADR-003).

## Starting it

```sh
pnpm run testenv:start
```

The first start takes a few minutes. Later starts reuse the containers and their data, and take
about a minute. `pnpm run testenv:start` does three things:

1. **It starts the containers**: `confluence-test-db` and `confluence-test-app`, on the
   `confluence-test` network. Their data is kept in the named volumes `confluence-test-pgdata` and
   `confluence-test-home`. The database settings and the license are passed to the containers as
   environment variables, so Confluence's setup wizard skips those steps.
2. **It provisions Confluence** the first time it runs. It completes the setup wizard over HTTP, with
   an empty site, internal users and the administrator account `admin`/`admin`. It then creates a
   personal access token and saves it in `test-env/.state/credentials.json`, which git ignores. The
   saved token is reused for as long as it keeps working.
3. **It seeds the test dataset.** It creates any spaces, pages, labels and attachments from
   `fixtures/dataset.mjs` that are missing, so running it again changes nothing. It writes each
   space's `.confluenceignore` file into `test-env/.state/data/spaces/<KEY>/`, which is the data
   directory the end-to-end tests run the app with, and saves every page's id in
   `test-env/.state/seed-manifest.json`.

The container runtime is chosen in this order: `podman`, then the host's podman through
`flatpak-spawn` (when running inside a toolbox container), then `docker`. Set
`CONTAINER_RUNTIME=docker`, `podman` or `host-podman` to choose one yourself.

## Running the app against it

`node test-env/testenv.mjs env` prints the variables that point the app at the test environment:
`CONFLUENCE_URL`, `CONFLUENCE_PERSONAL_TOKEN`, `CONFLUENCE_EXPLORER_DATA` (the data directory the
seed wrote the exclusion rules into) and `CONFLUENCE_EXPLORER_PROFILE=dev`. Export them in your shell
before `pnpm run dev`, and the app uses the test environment:

```sh
pnpm run testenv:start
export $(node test-env/testenv.mjs env | xargs)
pnpm run dev
```

The token is held by the server and never reaches the browser.

## The license

Atlassian no longer issues Data Center trial licenses to new customers. This setup uses Atlassian's
public timebomb developer license instead (`licenses/confluence-dc-timebomb.key`, published on
[developer.atlassian.com](https://developer.atlassian.com/platform/marketplace/timebomb-licenses-for-testing-server-apps/)).
It may be used for testing only (ADR-004).

The license expires three hours after Confluence starts, and restarting the container starts a fresh
three hours. `pnpm run testenv:status` shows when the current license expires. If it has run out,
`pnpm run testenv:down` followed by `pnpm run testenv:start` restarts Confluence with a new one. When
`CONFLUENCE_EXPLORER_PROFILE=dev` is set, the doctor (`confluence-explorer doctor`) warns when the
license is close to expiring.

## Commands

| command                   | `testenv.mjs` | what it does                                                                        |
| ------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `pnpm run testenv:start`  | `start`       | Starts the containers, provisions Confluence and seeds the dataset.                 |
| `pnpm run testenv:status` | `status`      | Shows the state of the containers and when the license expires.                     |
| `pnpm run testenv:seed`   | `seed`        | Seeds the dataset again. Pages that already exist are left alone.                   |
| `pnpm run testenv:logs`   | `logs`        | Follows the Confluence log.                                                         |
| `pnpm run testenv:down`   | `down`        | Stops the containers and keeps their data.                                          |
| `pnpm run testenv:reset`  | `reset`       | Deletes the containers, their volumes and `.state`, so the next start begins again. |
|                           | `env`         | Prints the variables that point the app at this environment.                        |

`testenv.config.json` holds the settings. The environment variables `CONFLUENCE_VERSION`,
`CONFLUENCE_PORT` and `CONFLUENCE_JVM_MAX` override them. Only Confluence 9.2.x has been checked with
the wizard automation; run `reset` before switching to another version.

## The test dataset (`fixtures/dataset.mjs`)

The dataset is the source of truth for the test spaces and their exclusion rules (ADR-007). Anything
generated from it, such as the `.confluenceignore` files, is overwritten on every seed.

| space                       | what it contains                                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAT` Platform Engineering | A six-level hierarchy (Onboarding down to VPN Troubleshooting); services, each with API, runbook and changelog pages; eight ADRs; incidents by year and quarter; container pages with no body; a page of every common macro; a `Restricted/` subtree. |
| `OPS` Operations            | Tables and nested tables, a title shared with PLAT (`Database Failover`), a title with unicode and emoji, a 40-section page, CSV and image attachments, links to other spaces.                                                                        |
| `PEOPLE` People and HR      | Policies, `Salary Bands` (excluded by its id), and an `Interviews/Internal/` subtree (excluded by its path).                                                                                                                                          |

The macros covered are info, warning, note, tip, panel, code (TypeScript, Python, SQL and bash),
noformat, status, expand, toc, children, excerpt, an unknown macro (jira), task lists, user mentions,
links to pages in the same and other spaces, and images.

### Exclusion rules

The rules are defined in `ignoreFiles` in the dataset. `{{id:Title}}` is replaced with the page's
real id when the seed runs.

| space  | rules                                                          |
| ------ | -------------------------------------------------------------- |
| PLAT   | `Restricted/` (a subtree), `*Sensitive*` (a title pattern)     |
| OPS    | none                                                           |
| PEOPLE | `id:<Salary Bands>`, `Interviews/Internal/` (a nested subtree) |

`expectations` in the dataset lists which pages must be hidden and which must stay visible, and the
end-to-end tests check every entry. One entry records a known defect: the rule `Restricted/` also
hides `Unrestricted Access Guide`, because a rule can match anywhere in a title (ADR-013). The test
for it is marked `todo` rather than deleted.

## The end-to-end tests

```sh
pnpm run test:e2e
```

The tests are in `packages/simply-confluence-explorer/test/e2e/`. Each one starts the app in the
test process, pointed at this environment and its data directory, and calls the app's API the way
the browser does. When the environment is not running, every test is skipped and the reason is
printed. They do not run as part of `pnpm test` (ADR-012).

In CI, the `e2e` workflow (`.github/workflows/e2e.yml`) starts this environment with docker and runs
the suite on every pull request (ADR-038). It sets `E2E_REQUIRE_TESTENV`, which makes a missing
environment fail the suite instead of skipping it, so a Confluence that failed to start cannot pass
as a green run.
