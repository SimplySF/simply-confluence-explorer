# Review packet for <version>

Copy this file to `docs/review/<version>.md` for the version about to be released, and fill it in.
`node scripts/release-gate.mjs <version>` reads the copy, and the release workflow will not publish
the version as a stable release until the gate passes (ADR-039).

**Status:** draft
**Second reviewer:** <name>
**Covers:** <the commit range reviewed, such as v0.1.0..main>

## What was checked

<The checks that were run, with the command or CI job for each.>

## What was not checked

<What nobody looked at, and why. This part matters most, because it tells a reader what to doubt.>

## Still outstanding

<Known problems that ship with this version.>

## Load-bearing surfaces

The second reviewer answers each surface independently of whoever built it. Each answer says what
was read, what could go wrong there, and whether this version gets it right. The headings must
match the surface names in the table in `AGENTS.md`; the gate reads that table.

### Writes to Confluence

**Answer:** _unanswered_

### HTTP to Confluence

**Answer:** _unanswered_

### Tokens

**Answer:** _unanswered_

### Pages sent to AI providers

**Answer:** _unanswered_

### The outbound guard

**Answer:** _unanswered_

### AI conversations and uploads

**Answer:** _unanswered_

### AI keys

**Answer:** _unanswered_

### External processes

**Answer:** _unanswered_

### Deletes files

**Answer:** _unanswered_

### Paths built from request values

**Answer:** _unanswered_

### Sensitive-data exclusion

**Answer:** _unanswered_

### The enforcement itself

**Answer:** _unanswered_
