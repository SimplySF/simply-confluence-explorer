# 0014 — A clearer layout for every main screen

**Status:** Implemented
**Package:** `packages/simply-confluence-explorer`
**Date:** 2026-10-23

## Problem

The app had grown a crowded sidebar, with a jump form, a sync badge, a Space menu, two full-width
buttons and the tree's tools stacked in it. No screen had an obvious first action: asking the AI
about a page was a tab among others, and a chat hid its suggestions, edits and staged pages behind
four tabs above the conversation. Space chat's Reading panel had to be opened, set to Chosen pages
and searched before it said what the chat read. Settings was one long form with two folded parts.

## Decision

Each main screen keeps its behaviour, routes and data flows, and changes only its layout, its order
of importance and its words, after a design handed over as a clickable prototype. The colours are
the existing theme's; the light theme's warning colour is darkened to reach 4.5:1 on its background.
The code and prose budgets rise for it (ADR-072).

## Behavior

- **Header** (`App.svelte`, `HeaderSearch.svelte`): one search finds a page in the open space by
  title, or resolves a pasted Confluence address or page id (`looksLikeAddress` in
  `support/pages.ts`), which may open another space; `/` focuses it. The status pill names the user;
  Observability, Settings and the theme are icon buttons. New page moves to the page as New sub-page.
- **Sidebar** (`Sidebar.svelte`, `SpaceActions.svelte`): the space switcher says how many pages are
  synced and when (`syncLine` in `support/spaceStatus.ts`). Update (or Sync), Exclusions and a menu
  for the rest sit in one row; Space chat and Review are navigation items, the second with a count
  of the chats with work waiting (design doc 0015); Pages or Tags, Expand all and Collapse all share
  a row above the filter.
- **Page view** (`PageView.svelte`, `ReadPanel.svelte`): breadcrumbs above the title, the page's
  facts as one line, and Review with AI as the primary action, which opens the Chat & review tab;
  that tab counts the suggestions waiting. Rendered, Markdown and Storage XML sit in the tab bar,
  and Confluence's info, tip, note, warning and panel macros render as callouts.
- **Chat & review** (`ChatWorkspace.svelte`, `ReviewFlow.svelte`, `ChatThread.svelte`): the
  conversation has the room, with a bar above its question box that says what its review holds, Add
  from chat, and Open the review. The review is its own place over the whole window, in four steps,
  Review, Edit, Stage and Push, as design doc 0015 describes; a side lane beside the chat proved too
  busy, and a side-by-side decision did not fit one.
- **Space chat** (`SpaceChat.svelte`, `ChatContext.svelte`): what the chat reads is a row of chips,
  with Whole space when there are none, and Add pages or tags opens a search of pages and tags. The
  list of chats folds to a strip.
- **Review** (`ReviewHub.svelte`, `PushQueue.svelte`), in place of Ready to push: the chats with
  work waiting, each opening its review, and a table of every staged page with where it sits and a
  bar beneath with Check and push; the check and its confirmation are unchanged.
- **Settings** (`SettingsDialog.svelte`, `AiSettings.svelte`, `GitLabSettings.svelte`): one section
  at a time, chosen from a list with a dot for each that is set up. A saved Confluence connection is
  tested when the dialog opens. Save & apply saves the section on screen.

## Alternatives considered

- **Deciding an edit in the side panel.** Two versions of a page side by side need the width of
  the window, so an open edit always takes it.
- **Keeping the four chat tabs and restyling them.** The tabs hid the queue while the conversation
  was open, which is when the chat adds to it. A queue beside the chat followed, and gave way to the
  review as its own place (design doc 0015).
- **A chosen-pages switch in Space chat.** An empty choice already means the whole space, so the
  switch only added a step.
- **Showing a whole space's sources under an answer.** An answer that read every page names the
  first six as chips and the rest on request, so the answer stays in view.

## Testing

- `test/web/pages.test.ts`: a pasted address or page id is told from a title.
- `test/web/spaceStatus.test.ts`: the sidebar's line about a space.
- `test/web/markdown.test.ts`: the panel macros as callouts, with markup in a title kept as text.
- `test/web/conventions.test.ts`: every class has a rule and every colour comes from the theme.
- The layout itself is checked by loading the built app against the fake Confluence in a browser,
  in light and dark, at full width and narrower; no test renders it.
