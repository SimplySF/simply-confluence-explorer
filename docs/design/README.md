# Design Documents

Every new feature in this repo gets a design document here **before** it gets code. The point isn't
ceremony — it's that a year from now, the "why" behind a feature's shape (why this route, why this
screen, what we rejected) is recoverable without archaeology through git history and PR threads.

## Process

1. **Write the design doc first.** Copy the [template](#template) into
   `docs/design/NNNN-short-slug.md`, using the next free four-digit number.
2. **Get agreement on it** — on the doc, not on the diff. Decisions are cheapest to change here.
3. **Implement**, then update the doc if the implementation taught you something the design got
   wrong. A design doc that quietly diverges from the shipped behavior is worse than none.
4. **Set the status line** to `Implemented` (with the PR link) when it lands.

A design doc is not a substitute for user-facing docs. Usage and options live in each package's
README — see the root `CONTRIBUTING.md` checklist. The design doc records the reasoning; the README
records the behavior.

## When a design doc is required

- Any new screen or user-facing workflow in the web app.
- Any new or changed `/api` route, or a change to its request/response shape or error behavior.
- Any change to how the app is started, configured, or bound to the network.
- Any new shared module, or a change to how packages depend on each other.
- Introducing a runtime dependency (including an Atlassian client), or changing how credentials
  are stored, read, or sent.

Not required for: bug fixes that restore documented behavior, dependency bumps, test-only changes,
refactors that keep the public surface identical (though a short doc is welcome for large ones).

## Index

| #                                      | Title                                                                        | Status  |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------- |
| [0001](0001-confluence-explorer.md)    | Confluence Explorer: what it does and how the package is built               | Planned |
| [0002](0002-runtime-dependencies.md)   | Runtime dependencies: simply-atlassian-core and `node:http`                  | Planned |
| [0003](0003-data-directory.md)         | Where the app keeps its data, and the token with it                          | Planned |
| [0004](0004-ai-providers.md)           | Asking an AI: one engine, an outbound guard, and conversations on the server | Planned |
| [0005](0005-writes-to-confluence.md)   | Writing to Confluence: a push, a branch's review queue, and a new page       | Planned |
| [0006](0006-end-to-end-environment.md) | The end-to-end suite runs against a real Data Center                         | Planned |

Design docs sit beside the [decision log](../decisions.md). A design doc describes a feature and is
corrected as the feature changes; the log is append-only and holds the rules, budgets and refusals
that are not one feature's (ADR-027). A design doc cites a record by number rather than restating
it.

## Template

```markdown
# NNNN — Title

**Status:** Draft | Planned | Implemented (PR #N) | Superseded by NNNN
**Package:** the `packages/*` this lands in
**Date:** YYYY-MM-DD

## Problem

What the user can't do today, and why that hurts.

## Decision

The one-paragraph answer: what we're building and where it lives.

## Behavior

The user-visible contract — screens, `/api` routes and their payloads, configuration, errors. Tables beat
prose for lookup rules.

## Alternatives considered

Each option we rejected and the specific reason. This section is the one future readers come back
for.

## Implementation plan

Files added/changed, in the order they'd be written.

## Testing

Unit test coverage, and what each case pins down.

## Open questions

Anything deliberately left undecided, and who decides it.
```
