# 0006 — The end-to-end suite runs against a real Data Center, locally and in its own CI job

**Status:** Planned
**Package:** repository root (`test-env/`, `.github/workflows/`)
**Date:** 2026-10-15

## Problem

The app's riskiest behaviour (exclusions, pushes, page creation) is only proved against a
Confluence that behaves like the real one. A fake of its REST API would agree with whatever the
code assumed (ADR-003).

## Decision

`test-env/` provisions Postgres and Confluence Data Center in containers with Atlassian's public
three-hour developer license (ADR-004), seeds the test dataset (ADR-007), and the end-to-end suite
runs against it. Locally it is started on its own (ADR-029). In CI it is a separate workflow,
`e2e.yml`, on Linux only, because the containers do not run on Windows runners.

## Behavior

| command                   | what                                                      |
| ------------------------- | --------------------------------------------------------- |
| `pnpm run testenv:start`  | start, provision and seed; podman or docker               |
| `pnpm run testenv:status` | what is running                                           |
| `pnpm run testenv:down`   | stop it; data stays in named volumes                      |
| `pnpm run test:e2e`       | the suite; skips with a message when no environment is up |

`test.yml` is unchanged: `pnpm test` excludes the end-to-end suite (ADR-012).

## Alternatives considered

- **Run it in `test.yml`.** Declined: it would put a container boot of several minutes in front of every
  push, on runners where half the matrix cannot run it.
- **No CI job, local only.** Declined: the suite is the evidence that the library's Data Center
  support works (ADR-028), and evidence only one machine has is not evidence for a reviewer.

## Implementation plan

`test-env/` moves to the repository root as it is, the suite moves into the package's `test/e2e/`,
and `e2e.yml` lands last, once the suite has something to prove.

## Testing

The workflow's first green run is its own test. It has not run anywhere yet (ADR-011), which is
stated in the pull request that adds it.

## Open questions

- Whether the repository owner wants the job on every push to a branch or on pull requests only.
