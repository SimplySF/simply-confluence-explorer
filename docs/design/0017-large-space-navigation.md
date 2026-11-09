# 0017 — Large spaces are navigated by a map of their directories, and can be reorganised

**Status:** In progress
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-11-09

## Problem

On spaces of more than 3,000 pages with deep trees, a question about the space often misses the
part of it that holds the answer, and a review of a large directory misses related pages. Four
causes were found in the code:

- The model is shown only the top two levels of the tree, eight pages to a level, so it cannot
  know that a deeper area exists.
- Metadata describes single pages. Nothing says what a directory holds, so the model cannot reason
  about areas of the space.
- Retrieval takes the 40 best-matching sections across the whole corpus. A large area of similar
  pages, such as hundreds of release notes, can fill all 40 places, and the Gemini CLI has no
  embeddings to match by meaning instead.
- The prompts ask for free-form JSON with long ids. A weaker model's malformed reply falls back to
  the plain search results without saying so.

A person also cannot see where the bulk of a space sits. Nothing shows how many pages are below a
page, so a large cache of old pages is found only by opening the tree level by level. Once found,
there is no way to gather those pages under one directory without moving each one in Confluence.

## Decision

- **Every page shows how many pages are below it**, and a **Space map** lists the largest subtrees
  with their size, their newest edit and whether they are a series of similar pages.
- **The AI index writes a digest for each directory** from its children's summaries, never their
  text, after the pages are indexed (ADR-079).
- **A large corpus is searched by a plan.** The model sees the directories as a numbered map and
  chooses the areas to search, each with what to look for. The search then takes its candidates
  from each chosen area in turn, so one large area cannot crowd out the rest.
- **Every structured request is checked and repaired once.** Choices are offered by number, the
  reply is validated, and a reply that fails is asked for again with the reason. A fallback is
  named in the answer's manifest.
- **A space can be reorganised**: a person makes new directories, drags pages into them, stages the
  changes, previews them with a dry run, and pushes them (ADR-081).

## Behavior

| route                                            | what it does                                                |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `GET /api/space-cache/:key/map`                  | Each directory's pages below, size, edits, and digest kind. |
| `GET`/`POST /api/space-cache/:key/restructure`   | The space's staged changes, and staging or undoing one.     |
| `POST /api/space-cache/:key/restructure/dry-run` | Checks every staged change against Confluence as it is now. |
| `POST /api/space-cache/:key/restructure/push`    | Makes the checked changes, one at a time, and reports each. |

- **The map** is worked out when it is read, from the page catalog and the current exclusion rules,
  so an excluded page is never counted or named. A subtree is marked stale when nothing in it has
  changed for a year, and a series when most of its pages have the same title apart from numbers
  and dates.
- **A digest** holds a summary, the kind of directory (living pages, an archive or series,
  templates, or a mix), its topics and the questions it answers. It carries a stamp of the allowed
  pages it was made from; a digest whose stamp no longer matches is treated as missing.
  The stamp hashes the directory's allowed children, each with the time its summary was made (or
  its version, before it has one), and the stamps of the directories below, worked out again from
  the exclusion rules each time a digest is read; `digests.json` drops a stale digest when it is
  next written. An index run digests the directories after the pages, lowest first, so a request
  carries the digests below it; a dozen directories go to a request, each with its children's
  titles, summaries and tags, a series of similar titles as one line, and at most 60 lines. The
  header shows **Directories x/y**, and the Space map shows each current digest's kind.
- **A plan** is shown under **What was sent**: the areas searched, why each was chosen, and the
  areas left out. The map lists only directories of the chat's corpus that the rules allow, each
  with its digest, or, without one, its summary and the names of the directories below it. A map
  larger than a quarter of the context is shown from the top, then below the areas chosen, at most
  three times. Half of the 40 candidates are shared among the chosen areas; the choice is told
  which candidates a plan's area found. A plan that cannot be read leaves one search of the corpus.
- **The diversity cap** applies to every search: no directory, and no series of similar titles,
  takes more than 8 of the 40 candidates unless the cap would leave fewer than 10.
  A thorough answer takes its 150 sections across the planned areas the same way, and a batched
  review groups pages by their area one level below the corpus's top before their shared topics.
- **A structured request** gives the model one task, short numbered rules and an example of the
  reply, and offers its choices by number. A reply that fails its check is asked for once more with
  the reason; a second failure is named under **What was sent** and counted in the telemetry. In an
  index pack, a page with no summary, or with lines for fewer than four in five of its sections, is
  asked for alone. The Gemini API is asked for JSON held to a schema. The Gemini CLI is not, so the
  index sends it packs of 25,000 characters instead of 60,000.
- **A move** carries the page's version and parent at the time it was staged, and takes the page's
  whole subtree with it. A dry run reads each page from Confluence again and refuses a change whose
  page has moved on. A push needs a dry run of the same staged changes, stops at the first failure,
  and leaves what it did not reach staged. The page's body is written back exactly as it was.
  Data Center 9.2 has no REST call that only moves a page, so a move is an update that names the
  new parent, and each moved page gains a minor version marked as a move. Confluence reports the
  old ancestors of a moved page's children for a while afterwards, so the synced copy works out
  their new place from the moved page instead of reading it back.
- **A new directory** is a page created through the check of ADR-025: its title is searched for
  among existing pages, and the person chooses to use one of them instead or to create it.

## Alternatives considered

- **A longer outline in every request.** On a 3,200-page space a full outline is larger than the
  context it would leave room for, and it still says nothing about what each directory holds.
- **Expanding a question with the space's topics.** Declined by ADR-056; the plan routes by the
  tree's own structure instead.
- **Deleting or archiving pages from the app.** Not chosen: moving old pages under one directory
  and leaving it out is enough to keep them from crowding answers, and it changes no page's text.

## Testing

- `test/spaceMap.test.ts`: counts, sizes, dates and series, and no excluded page in the map.
- `test/structured.test.ts`: a reply is validated, repaired once, and a fallback is reported.
- `test/digests.test.ts`: a digest is made from summaries only, and goes stale when an exclusion is
  added.
- `test/plannedRetrieval.test.ts`: the cap, the plan and its fallback, the map shown in rounds, and
  no excluded directory in a planning request.
- `test/retrievalEval.test.ts`: on a deep generated space, questions whose answers sit in deep areas
  find those areas; the share found is held above a floor.
- `test/restructure.test.ts`: a page is never moved under itself, a changed page is refused at the
  dry run and the push, a push needs a current dry run, and a failure leaves the rest staged.
- The end-to-end suite moves a subtree in the test Confluence and checks its parent and its body.
