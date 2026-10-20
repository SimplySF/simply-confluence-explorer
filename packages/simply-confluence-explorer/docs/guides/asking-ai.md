---
title: Asking an AI
description: Choose an AI provider, then chat about a page, a directory, any mix of directories, pages and tags, or a whole synced space, however many pages that is.
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

## Chat about a page or a directory

Open a page and choose the **Chat** tab.

![A chat about a page and the pages under it, with the leak guard note above the answer](../images/ask-ai.webp)

1. Choose what the chat reads:
   - **With sub-pages**: the page and every page under it, if the space is synced. This is chosen
     whenever the page has sub-pages, so a directory is read as a whole.
   - **This page**: the page you are looking at, on its own.
2. Click one of the quick questions (**Summary**, **Action items & decisions**, **Technical
   review**, **Runbook checklist**, **Explain simply**), or type your own and click **Send**.

The answer appears under your question, with the provider's name and the time, a line saying what
the leak guard did, and **Read N pages**, which lists the pages it read. **Markdown** shows the
answer's source text, and **Copy** copies it. To change pages from a chat, see
[Changing pages from a chat](/guides/changing-pages/).

While the AI is answering, **Send** becomes **Stop**. Stopping puts your question back in the box so
you can correct it and send it again; nothing of the stopped question is kept in the conversation.
The provider may already have received it, so the app's AI log records it as stopped.

The app sends its own copy of each page, the one it checked against the exclusion rules, never text
from the browser. A page excluded from AI shows a notice instead of the question box.

### Conversations

A conversation keeps going until you click **New conversation**: each question is sent with the
earlier ones, so you can ask follow-ups. Conversations are saved on your computer, and when you come
back to a page the latest conversation for it reopens. Earlier turns are sent up to a limit, newest
first, so a very long conversation gradually forgets its start. Every page is read and checked again
for every question, so a change to the exclusion rules applies to the next question.

### Add a file

The paperclip next to the question box adds a file to the conversation, for example a design
document or a log to compare with the page: PDF files with text in them, HTML, Markdown and plain
text, and CSV, TSV, JSON, YAML, XML and log files, up to 10 MB each. The leak guard checks files like
everything else, but exclusion rules do not apply to them, because they are not Confluence pages.

## Chat about the whole space, or about pages you choose: Space chat

**Space chat**, at the top of the sidebar, is for the space as a whole. It answers from the synced
copy, so sync the space first. Its conversations are listed on the left, newest first, and kept on
your computer. **New chat** starts another; the pencil renames one, and the bin deletes it after you
confirm.

![Space chat answering from the whole space, with the pages it read and why](../images/space-chat.webp)

**Reading** above the conversation says what the chat reads; click it to change it. The line under
it says how many pages that is, and how each question reads them.

- **Whole space**: every page in the space that the exclusion rules allow.
- **Chosen pages**: any mix of directories, single pages and tags. Type in **Find a page or
  directory** to see matching pages with where each one sits. **Add page** adds that page alone, and
  **Add with N sub-pages** adds it with every page under it, so you can choose two directories and a
  page from another part of the space. **Or add every page with a tag** adds a tag's pages. Each item
  under **Chosen** is removed with its ×; a directory goes in one click, with its sub-pages. A
  directory or tag is read as it is when you ask, so a page added under it later is read too.

![Space chat with two directories and a page chosen, and the line saying how they are read](../images/space-chat.webp)

There is no limit on how many pages a chat reads from:

- **When they fit in one request**, every question reads all of them, and the line says so.
- **When there are more**, each question finds the sections it needs. Pages are split at their
  headings, and the app ranks the sections by the words of your question and the one before it,
  and, with a provider that offers embeddings, by meaning as well. The AI then picks the sections
  worth reading from their headings and summaries alone, and only those are sent, with the ones the
  last answers read. **Read N sections from M pages** on each answer lists them, with why each was
  chosen. This is the way in when you do not know the space, such as an unfamiliar system during an
  incident.

![The pages tagged runbook in the sidebar's Tags view, each with where it sits](../images/tags-view.webp)

**Chat about** on a tag in the sidebar's **Tags** view opens a chat on that tag's pages. A page's tags
are its Confluence labels together with the topics of its AI summary. Excluded pages are never
listed, found or read, and a page holding a secret is left out and named.

## Summaries, topics and embeddings

Chats find more when their pages have AI summaries. A summary says what a page is for, gives it
topics, lists the questions it answers and who it is for, and describes each section in a line, and
the search reads all of it. Topics are chosen from the ones the space already uses where one fits,
so pages about one subject share a tag wherever they sit. A chat says how many of its pages have an
up-to-date summary and offers **Generate the missing summaries**, which runs in the background and
shows in the header.

With **ChatGPT** or **Gemini (Google API)**, the same run also makes an embedding of each section,
which lets a question find a section by meaning when it shares none of its words. Claude and the
Gemini CLI offer no embeddings, so with them the search uses words and summaries alone.
[What leaves your computer](/guides/data-safety/) says what this sends.

The **Details** tab of a page has **Generate summary** for that page alone, and shows the summary,
its topics and the questions it answers. **Space → Generate AI summaries** runs for every page that
has no up-to-date summary. A page that changes in Confluence loses its summary and embeddings at the
next sync, and **Update AI summaries** redoes only those pages.

## How this is checked

`test/ai.test.ts` checks how each provider is called, that a key is stored owner-only and never shown,
and that a missing key or model is reported before anything is sent. `test/sessions.test.ts` checks
conversations, the history limit, file uploads, chosen directories, pages and tags, reading in full
or by section, and finding a section by meaning. `test/sections.test.ts`, `test/searchIndex.test.ts`,
`test/metadata.test.ts` and `test/embeddings.test.ts` check how pages are split, searched, summarised
and embedded. `test/aiRoutes.test.ts` checks that excluded pages are refused and that summaries reach
the table of contents. `test/e2e/ai.e2e.ts` asks questions against a real Confluence Data Center,
with a stand-in for the AI provider.
