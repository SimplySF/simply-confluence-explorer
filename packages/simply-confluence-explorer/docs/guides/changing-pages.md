---
title: Changing pages from a chat
description: Collect a chat's suggestions in its review queue, rework them with the chat, decide each change side by side, stage the pages, and push them to Confluence without overwriting anyone else's edit.
sidebar:
  order: 6
---

Every change Confluence Explorer makes to a page starts in a chat (see
[Asking an AI](/guides/asking-ai/)): one page, a directory, any mix of directories, pages and tags,
or the whole space. Each chat has four tabs: **Chat**, **Review**, **Changes** and **Push**. The
question box stays under every tab, so you can ask the chat to rework something while you look at
it. Nothing changes in Confluence until you confirm a push.

## Get suggestions

- **Start a chat with a review.** A new chat on a directory or on chosen pages offers **Review for
  problems**: pages that contradict or repeat each other, content that is out of date, and pages that
  are missing or in the wrong place. A new chat on one page offers **Suggest improvements**.
- **Turn a conversation into changes.** Once a chat has begun, **Turn this into changes** lists the
  changes the conversation found or agreed.

The suggestions go to the chat's **Review** tab, and the answer says how many, with a link. When a
chat's pages are too many for one request, the review reads them in batches, related pages together,
and the header shows its progress; **Stop** ends it with nothing kept.

## Rework them with the chat

Ask the chat in your own words, for example "make the first one more specific" or "drop the one
about the pager". It rewords, adds or removes suggestions, and the answer says what it changed. A
reworded suggestion keeps its earlier wordings under **Reworded**, and **Use this** puts one back.

Review is in four parts: **To recommend**, **In progress** (an edit being written, to decide,
staged, or failed), **Not edited** (an edit that changed nothing or was not sent, with why) and
**Closed** (pushed, already done, no longer relevant, dismissed). A suggestion
with an edit under way is not ticked again; **Recommend again** offers it once its edit failed, or
the chat reworded it.

![The Review tab, grouped by page, with a reworded suggestion](../images/review-queue.webp)

Every suggestion that cannot be ticked says why:

- **Moving, splitting or merging a page** is done in Confluence. For a page that should exist and
  does not, **Write a new page** opens [Writing a new page](/guides/new-pages/).
- **Redrawing an image, a diagram or a chart's look, or changing a macro's settings**, is work only
  a person can do: an edit changes only text. Such a suggestion says "The AI cannot make this
  change" and what to change in Confluence. When only part of a suggestion is like that, it can
  still be ticked, says which part is yours, and its edit lists it under **To do in Confluence**.
- **A page the chat did not read** is named, with a reminder to ask about that page to edit it.

## Recommend changes

Tick the suggestions you want and click **Recommend changes**. The bar counts the pages they name,
such as "3 suggestions → 5 pages", and each page gets one edit carrying out only those suggestions.
Several pages are written at once, as many as Settings → AI provider → requests at once allows. Before the edit is written, the page is read from
Confluence. If someone changed it since the suggestion was made, the copy on your computer is
updated, and the AI first checks each suggestion against the page as it is now: one that is already
done, or no longer makes sense, is not applied and goes back to Review with the reason.

## Decide each change, side by side

The **Changes** tab lists the edits, grouped by each time you recommended changes. A page being
written shows its current step and how long it has taken; open it to follow every step and the
answer so far, where the AI streams it, until it turns into the edit. Open one to see the page as it is now on the left and the edit
on the right. Each change sits between them with **Accept** and **Reject**, and **Undo** to change
your mind; **Accept all** and **Reject all** decide the page at once. Beside it is the AI's
recommendation: the suggestions applied, what it says it changed, and anything it did not apply.

![An edit side by side, with the AI's recommendation](../images/edit-side-by-side.webp)

**Work on this edit in the chat** makes your next question about that edit, shown as "Working on"
above the question box. Ask for a change, such as "shorter", and the chat proposes a revised edit;
**Accept into the edit** adds its changes for you to decide, or **Dismiss** it. **Edit the text**
lets you change the page yourself, **Reset to the AI's edit** brings back the first edit, and **What
will be written** shows the page with only the accepted changes.

Parts of a page that Markdown cannot hold, such as a table of contents, a status, a panel, an image
or a page link, appear as markers like ⟦1 toc⟧ and are written back exactly as they were. An image
attached to a synced page, and a draw.io or Gliffy diagram's preview, is shown above its marker. A change
that removes one says so, and the part is removed only if you accept that change. A page's own
details, such as its id, version and author, are never written into it.

## Stage and push

Once every change of a page is decided, with at least one accepted, **Stage** moves it to the
**Push** tab. Changing the edit after that unstages it, so what you push is what you looked at.
**Ready to push** in the sidebar lists the staged pages of every chat in the space.

Tick the pages to push and click **Check and push**. Each page is checked without writing anything,
then the confirmation lists what will be written and any page with a problem, with why.

![The confirmation before a push, naming the pages](../images/push-confirm.webp)

Each push names the version its edit was made from. A page someone changed since is refused and
nothing is written over their change; **Make this edit again from the current page** starts again
from the page as it is now.

## What is left out

- **Excluded pages** are never read, suggested, edited or listed, and never named.
- **Pages holding a secret** are left out and listed under "Left out".

Chats, their queues and their edits are saved on your computer, so they survive restarting the app.

## How this is checked

`test/chatQueue.test.ts` checks that the chat rewords, adds and removes suggestions and an earlier
wording comes back, that an edit is made from the newer page and a suggestion already done is not
applied, that the chat's revision is accepted or dismissed and its page is checked on every turn, and
that only staged pages are pushed, never an excluded one. `test/branchRuns.test.ts` checks that each
edit carries only its own suggestions, that only accepted changes are written with a table of
contents kept, that a page changed by someone else is refused, and that a page's own details are
never written, that an edit that changes nothing is not edited and says why, and that a suggestion
only a person can do cannot be recommended. `test/attachments.test.ts` checks that an edit's images
are served only as images of a synced page that is not excluded. `test/editForm.test.ts` checks that every test page is written back exactly when
nothing changes. `test/e2e/branches.e2e.ts` makes, stages and pushes an edit from a page a colleague
changed, and `test/e2e/push.e2e.ts` changes a page with a panel, against a real Confluence Data Center.
