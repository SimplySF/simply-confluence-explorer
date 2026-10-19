---
title: Asking an AI
description: Choose an AI provider, then ask about a page, a page and everything under it, or a whole synced space, with files of your own added to the conversation.
sidebar:
  order: 4
---

Confluence Explorer can send a page, or several, to an AI along with your question, and show the
answer next to the page. Before anything is sent, the app removes excluded pages and passes the rest
through the leak guard; [What leaves your computer](/guides/data-safety/) explains both.

The AI features have so far been tested only against a stand-in for each provider's service, not
with real provider keys. Expect rough edges with a real provider, and report them.

## Choose a provider

Open **Settings** and expand **AI provider**.

![The AI provider settings, with a provider, key, model and endpoint](../images/settings-ai.webp)

| Provider               | What you need                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Gemini CLI             | The [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and signed in on this computer |
| Claude (Anthropic API) | An Anthropic API key                                                                                   |
| ChatGPT (OpenAI API)   | An OpenAI API key, and a model you choose                                                              |
| Gemini (Google API)    | A Google AI API key                                                                                    |

- **API key**: paste it and click **Save AI settings**. The key is stored on your computer and never
  sent back to the browser; the field only says whether a key is set, and where it came from.
- **Model**: Claude and Gemini start with a sensible default. For ChatGPT you must choose one. After
  saving a key, **Models** lists the models that key can use.
- **Endpoint (optional)**: leave it empty to use the provider's public service, or enter your
  company's AI gateway address if requests must go through one.
- **Test** sends the fixed sentence "This is a connection test." to the provider, with no page, and
  shows the reply.

The AI settings are saved separately from the Confluence connection, with their own **Save AI
settings** button, and take effect at once.

You can also set a key with the environment variables `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or
`GEMINI_API_KEY`, and the provider with `AI_PROVIDER`. A key saved in Settings wins over the
environment.

## Ask about a page

Open a page and choose the **Ask AI** tab.

![An AI summary of a page, with the leak guard note above the answer](../images/ask-ai.webp)

1. Choose what to ask about:
   - **With sub-pages**: the page and every page under it, if the space is synced. This is chosen
     whenever the page has sub-pages.
   - **This page**: the page you are looking at, on its own.

   A question about the whole space is asked in **Space chat** instead (see below).

2. Click one of the quick questions (**Summary**, **Action items & decisions**, **Technical
   review**, **Runbook checklist**, **Explain simply**), or type your own and click **Send**.

The answer appears under your question, with the provider's name and the time, and a line saying
what the leak guard did. **Markdown** shows the answer's source text, and **Copy** copies it.

While the AI is answering, **Send** becomes **Stop**. Stopping puts your question back in the box so
you can correct it and send it again; nothing of the stopped question is kept in the conversation.
The provider may already have received it, so the app's AI log records it as stopped.

The app sends its own copy of the page, the one it checked against the exclusion rules, never text
from the browser. A page excluded from AI shows a notice instead of the question box; you can still
ask about the whole space in Space chat, which leaves the excluded page out.

### Conversations

A conversation keeps going until you click **New conversation**: each question is sent with the
earlier ones, so you can ask follow-ups. Conversations are saved on your computer, and when you come
back to a page the latest conversation for it reopens. Earlier turns are sent up to a limit, newest
first, so a very long conversation gradually forgets its start.

The page is read again for every question, so if you change the exclusion rules partway through a
conversation, the next question already follows them.

### Add a file

The paperclip next to the question box adds a file to the conversation, for example a design
document or a log to compare with the page. The app accepts:

- PDF files with text in them (a scanned PDF has no text, and is refused);
- HTML, Markdown and plain text;
- CSV, TSV, JSON, YAML, XML and log files.

Each file can be up to 10 MB, and very long text is cut to fit. The leak guard checks files like
everything else, but exclusion rules do not apply to them, because they are not Confluence pages.

## Ask about a whole space: Space chat

**Space chat**, at the top of the sidebar, is for questions about the whole space rather than one
page. It answers from the synced copy, so sync the space first. Its conversations are listed on the
left, newest first, and kept on your computer, so you can come back to any of them. **New chat**
starts another; the pencil renames one, and the bin deletes it after you confirm.

![Space chat, with a conversation, the pages each answer used, and a pinned page](../images/space-chat.webp)

For each question the app searches the space's titles, tags, AI summaries and page text, and sends
the pages that match best, together with the pages the last answers used and an outline of the
space, up to the size limit. It also searches on your previous question, so a follow-up such as
"and how do we roll that back?" still finds the right pages. Each answer lists the pages it used;
click one to open it.

To make sure a page is always read, pin it: type its title in **Pin a page to every answer**. With
**Only these pages** ticked, answers come from the pinned pages alone. **Ask** on a tag (see
[Reviewing a section](/guides/reviewing-a-section/)) starts a chat with the tag's pages pinned this
way. Excluded pages can never be pinned or found, and a page holding a secret is left out and named.

The better your pages' summaries, the better the search works: **Space → Generate AI summaries**
gives every page one.

## Summaries and topics

The **Details** tab of a page has **Generate summary**, which asks the AI for a short summary, topic
tags, the kind of document (runbook, policy, guide and so on), and the systems it mentions. On a
synced page the summary is saved, and appears in the table of contents and helps whole-space
questions find the page. **Space → Generate AI summaries** does the same for every page in the space
that has no summary yet.

## How this is checked

`test/ai.test.ts` checks how each provider is called, that a key is stored owner-only and never shown,
and that a missing key or model is reported before anything is sent. `test/sessions.test.ts` checks
conversations, the history limit and file uploads. `test/aiRoutes.test.ts` checks that excluded pages
are refused and that summaries reach the table of contents. `test/e2e/ai.e2e.ts` asks questions
against a real Confluence Data Center, with a stand-in for the AI provider.
