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

| #   | Title | Status |
| --- | ----- | ------ |

_(empty — this repo is framework-only so far)_

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
