# 0006 — The end-to-end suite runs against a real Data Center, locally and in its own CI job

**Status:** Planned
**Package:** repository root (`test-env/`, `.github/workflows/`)
**Date:** 2026-10-15

## Problem

The riskiest things the app does are excluding pages from AI, pushing changes to pages, and
creating new pages. The only way to show that these work is to run them against a Confluence that
behaves like the real one. A fake of Confluence's REST API would not do: it would behave however the
code already assumed Confluence behaves, so it could never catch a wrong assumption (ADR-003).

## Decision

`test-env/` runs a real Confluence Data Center for testing:

- It starts Postgres and Confluence Data Center in containers.
- It licenses Confluence with Atlassian's public three-hour developer license (ADR-004).
- It seeds Confluence with the test dataset, the fixed set of spaces and pages the tests expect
  (ADR-007).

The end-to-end suite then runs against that environment. On a developer's machine, the environment
is started with its own command, separately from the app (ADR-029). In CI, the suite runs in a
separate workflow, `e2e.yml`, on Linux only. GitHub's Windows runners cannot run the Linux
containers this environment needs.

## Behavior

| command                   | what it does                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm run testenv:start`  | Starts the environment, sets up Confluence, and seeds the test dataset. Works with podman or docker. |
| `pnpm run testenv:status` | Shows what is running.                                                                               |
| `pnpm run testenv:down`   | Stops the environment. Its data is kept in named volumes, so the next start is faster.               |
| `pnpm run test:e2e`       | Runs the end-to-end suite. If no environment is running, the suite skips and says why.               |

`test.yml` does not change. `pnpm test` does not include the end-to-end suite (ADR-012), so the
everyday test run stays fast and needs no containers.

## Alternatives considered

- **Run the suite in `test.yml`.** Declined. It would add a container start-up of several minutes to
  every push, and half of that workflow's matrix runs on Windows, where the containers cannot run.
- **Run the suite locally only, with no CI job.** Declined. The suite is the evidence that the
  library's Data Center support works (ADR-028). Evidence that exists on only one person's machine
  cannot be checked by a reviewer.

## Implementation plan

- `test-env/` moves to the repository root unchanged.
- The suite moves into the package's `test/e2e/` directory.
- `e2e.yml` lands last, once the suite has the app's features to test.

## Testing

The workflow is proved by its own first green run. It has not run anywhere yet (ADR-011), and the
pull request that adds it will say so.

## Open questions

- Whether the repository owner wants the job to run on every push to a branch, or only on pull
  requests.
