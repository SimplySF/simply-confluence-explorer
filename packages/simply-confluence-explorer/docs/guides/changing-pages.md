---
title: Changing pages from a chat
description: Ask a chat for suggestions, tick the ones you want, read each page's edit, and push the accepted ones to Confluence without overwriting anyone else's change.
sidebar:
  order: 6
---

Every change Confluence Explorer makes to a page starts in a chat (see
[Asking an AI](/guides/asking-ai/)): one page, a directory, pages chosen by tag, or the whole space.
You ask for suggestions, tick the ones you agree with, read the edit each page gets, and push only
what you accept. Nothing changes in Confluence until you confirm a push.

## Get suggestions

In a chat, ask for them in one of three ways:

- **Review for problems**, in a chat on a directory or on chosen pages: the AI reads the pages
  together and lists what is wrong across them, such as pages that contradict or repeat each other,
  content that is out of date, and pages that are missing or in the wrong place.
- **Suggest improvements**, in a chat on one page: clarity, missing detail, structure and the like.
- **Turn this into changes**, at any point in a conversation: the AI lists the changes the
  conversation found or agreed. Talk it through first, then turn it into changes.

![Suggestions from a chat on a tag's pages, two of them ticked](../images/chat-suggestions.webp)

Each suggestion names the pages it is about; click a name to open the page. Two kinds cannot be
carried out by editing a page, so they cannot be ticked: a page that should be moved, split or merged,
which you do in Confluence, and a page that should exist and does not. For a missing page, **Write a
new page** opens [Writing a new page](/guides/new-pages/) with the suggestion filled in.

## Queue the ones you want

Tick the suggestions you agree with, or **Select all**, and click **Queue selected**. Each page a
ticked suggestion names gets an edit that carries out only the suggestions about it and leaves the
rest of the page as it is; when a suggestion is about repetition across two pages, each page's edit
is told which other page shares the content. The edits arrive one page at a time under the
suggestions, and the header shows them while they are being written. **Stop** ends it at once.

![The queue of edits, with one page's changes and its Accept and Reject buttons](../images/chat-queue.webp)

For each page, read the suggestions it applies and its **Changes**, then **Accept** it, **Edit** it and
**Accept with my edits**, or **Reject** it. **Undecide** puts it back. Each edit is made from the app's
own copy of the page, after the exclusion check, and remembers the version of the page it was made
from.

## Check and push

**Dry run accepted** checks every accepted page without writing anything. **Push N to Confluence**
asks you to confirm, then writes the accepted pages one at a time.

![The confirmation before a push, naming the pages](../images/push-confirm.webp)

Each push names the version its edit was made from. If anyone has changed the page in Confluence
since, that page is refused and nothing is written over their change, while the other accepted pages
are still written. Ask for suggestions again to start from the page as it is now.

## Pages that cannot be pushed

Some parts of a Confluence page have no form in Markdown: images, macros such as status labels,
panels, Jira issues, expand sections and tables of contents, links to other pages, mentions, task
lists and page layouts. The app shows each as text in brackets, such as `[image: chart.png]` (see
[Keeping a copy on disk](/guides/syncing-a-space/)). A push replaces the whole page, so pushing that
text would replace each of those parts with its placeholder. To prevent that, **the dry run and the
push refuse any page that holds one of them**, name exactly what it would lose, and write nothing.

![A dry run refusing an edit, naming the macro the page would lose](../images/improve-refused.webp)

Code blocks survive the round trip and do not stop a push. For any other page, use the edit as a
guide and make the change in Confluence itself. The rule follows the converter, not a fixed list, so
a part a later version learns to carry stops blocking pushes without any change on your side.

## What is left out

- **Excluded pages** are never read, suggested or edited, and never named.
- **Pages holding a secret** are left out and listed under "Left out", so you know they were not read.
- **The frontmatter block** at the top of the Markdown is never written to Confluence.

Queues are saved on your computer, so they survive restarting the app.

## How this is checked

`test/branchRuns.test.ts` checks that suggestions are stored with the answer and never come from the
browser, that each edit carries only its own suggestions, that only accepted pages are written, that
a page changed by someone else is refused while the others are written, that a dry run writes
nothing, and that a stopped queue stops. `test/pagePush.test.ts` checks the version check and that a
page with an image or a page link is refused. `test/e2e/branches.e2e.ts` queues and pushes an edit
against a real Confluence Data Center.
