# @simplysf/simply-confluence-explorer

A local web app for browsing and exploring Confluence, packaged as a Node.js CLI. Part of the
[`simply-confluence-explorer`](https://github.com/SimplySF/simply-confluence-explorer) monorepo.

> **Status:** the server reads Confluence, keeps a copy of a space on this machine, asks an AI about
> pages and spaces, and improves a page: it proposes a revision, checks it, and pushes it, refusing a
> push made from a version that has since changed. Branch review queues, creating pages and the
> browser interface are not built yet.

## Usage

```sh
npx @simplysf/simply-confluence-explorer
# Confluence Explorer is running at http://127.0.0.1:4280/
```

| Option              | Environment                | Default                  | Description                                    |
| ------------------- | -------------------------- | ------------------------ | ---------------------------------------------- |
| `-p`, `--port <n>`  | `PORT`                     | `4280`                   | Port to listen on; `0` picks a free port       |
| `--host <host>`     | `HOST`                     | `127.0.0.1`              | Interface to bind; set explicitly to expose it |
| `--data-dir <path>` | `CONFLUENCE_EXPLORER_DATA` | `~/.confluence-explorer` | Where the app keeps everything it writes       |
| `-h`, `--help`      |                            |                          | Show usage                                     |

A flag wins over its environment variable. The server listens on localhost only unless you pass
`--host`. It holds your Confluence token, so think twice before exposing it on a network. When it is
reached by another name, list that name in `ALLOWED_HOSTS`; every other host name, and every request
another website sends from your browser, is refused (`test/security.test.ts`).

### Checking your setup

```sh
npx @simplysf/simply-confluence-explorer doctor
```

The doctor checks the Node version, the Confluence connection, certificate checking and the data
directory. It prints what to do about each problem it finds, and exits with a non-zero status only
when something is broken. `--json` prints the report as JSON (`test/doctor.test.ts`).

### Connecting to Confluence

Save the URL and a personal access token in the app's Settings. The token stays on the server and is
never sent back to the browser (`test/connection.test.ts`). To set the connection outside the app
instead, use the same variables as the `simply` command, either in the environment or in a `.env`
file in the data directory:

```sh
CONFLUENCE_URL=https://confluence.example.com
CONFLUENCE_PERSONAL_TOKEN=<your personal access token>
```

### Choosing an AI

Choose the provider, model and key in the app's Settings. Keys are kept on the server and never sent
back to the browser (`test/ai.test.ts`). The environment can supply them instead:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`, with `AI_PROVIDER` naming which one to use
(`anthropic`, `openai`, `gemini`, or `gemini-cli` for the Gemini command-line tool, found on `PATH`
or at `GEMINI_CLI_PATH`). A value saved in Settings wins over the environment.

Before anything is sent, the page is checked against the space's `.confluenceignore`, and the
request passes the outbound guard: a secret stops it, and personal data is replaced with
placeholders that are put back in the answer here (`test/aiRoutes.test.ts`, `test/guard.test.ts`).
Each request is recorded in `data/ai-audit.jsonl` in the data directory, without its content.

### Writing to Confluence

A page changes only when a push is sent for it. The push names the version its proposal was made
from, and is refused if the page has changed since, so a colleague's edit is never replaced unseen
(`test/pagePush.test.ts`, and against a real Confluence, `test/e2e/push.e2e.ts`). The frontmatter
block the app adds to a page's Markdown is removed before the page is written.

Certificates are always verified. If your Confluence uses a certificate from your company's own
certificate authority, ask your IT team for that authority's certificate file and start the app with
`NODE_EXTRA_CA_CERTS` pointing at it:

```sh
NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem npx @simplysf/simply-confluence-explorer
```

## HTTP routes

| Route                                                 | Description                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                     | `{ "status": "ok", "version": "<package version>" }`                                                                                            |
| `GET /api/connection`                                 | The Confluence URL, whether a token is saved, and where the connection comes from                                                               |
| `PUT /api/connection`                                 | Saves `{ baseUrl, token }`; the token is never returned                                                                                         |
| `GET /api/doctor`                                     | The doctor's report, as `confluence-explorer doctor --json` prints it                                                                           |
| `POST /api/auth/verify`                               | Tests the saved connection, or one typed into Settings, without saving it                                                                       |
| `GET /api/spaces`                                     | Every global space; `?query=` filters by key or name                                                                                            |
| `GET /api/spaces/detail/:spaceKey`                    | One space                                                                                                                                       |
| `POST /api/spaces/resolve-url`                        | Finds the page id and space key in a pasted address or page id                                                                                  |
| `GET /api/spaces/:spaceKey/pages`                     | The space's page tree, or the tree under `?rootPageId=`, without excluded pages                                                                 |
| `GET /api/pages/:pageId`                              | One page and its Markdown; an excluded page is a `404`                                                                                          |
| `POST /api/parse`                                     | Converts a pasted storage-format snippet to Markdown                                                                                            |
| `GET`/`POST /api/space-cache/:spaceKey/ignore`        | Reads or saves the space's `.confluenceignore` rules; with `purge: true`, also deletes the synced copies they now exclude                       |
| `GET /api/space-cache/cached`                         | The spaces synced to this machine                                                                                                               |
| `POST /api/space-cache/sync`                          | Starts syncing `{ spaceKey, rootPageId? }` to disk; poll `GET /api/space-cache/sync/status/:jobId`                                              |
| `GET /api/space-cache/:spaceKey/toc`                  | The synced space's table of contents                                                                                                            |
| `GET /api/space-cache/:spaceKey/zip`                  | The synced space as a ZIP of Markdown and attachments, without excluded pages                                                                   |
| `POST /api/space-cache/:spaceKey/pages/:pageId/purge` | Removes a synced page, optionally with what is below it and a rule to keep it away                                                              |
| `POST /api/space-cache/:spaceKey/cache/purge`         | Removes synced copies that are excluded, or whose Markdown was deleted from the folder                                                          |
| `GET`/`PUT /api/ai/settings`                          | The AI provider, model and endpoint; keys can be saved but are never returned                                                                   |
| `GET /api/ai/models/:provider`                        | The models the saved key can use                                                                                                                |
| `GET /api/ai/status`, `POST /api/ai/test`             | Whether an AI is set up; a test call that sends no page                                                                                         |
| `POST /api/ai/analyze`                                | One question about a page, optionally with its sub-pages; the server sends its own copy of the page it checked, never text the request supplies |
| `POST /api/space-cache/:spaceKey/ai/ask`              | One question about a synced space, answered from its best-matching pages                                                                        |
| `/api/ai/sessions/...`                                | Conversations: create, list, read, delete, upload a file, send a message                                                                        |
| `POST /api/space-cache/:spaceKey/metadata/generate`   | Starts AI summaries for a synced space; poll `GET /api/space-cache/metadata/status/:jobId`                                                      |
| `POST /api/pages/:pageId/recommend`                   | A proposed revision of the page, made from the server's own copy, with the version it was made from                                             |
| `POST /api/pages/:pageId/dry-run`                     | Converts a change as a push would, and reports anything Confluence would refuse, without writing                                                |
| `POST /api/pages/:pageId/push`                        | Writes `{ markdown, baseVersion }`; refused with a `409` if the page has changed since `baseVersion`                                            |
| `GET`/`POST /api/space-cache/:spaceKey/guard`         | Reads or saves the space's `.confluenceguard` rules; a rule that does not parse is refused                                                      |
| `/api/*`                                              | Anything else under `/api` is a JSON `404`, never the app shell                                                                                 |
| everything else                                       | The built frontend, falling back to `index.html` for client-side routes                                                                         |

A page listed in a space's `.confluenceignore` is left out of every tree, together with everything
below it, and reading it answers `404`, so it never reaches the browser (`test/browse.test.ts`, and
against a real Confluence, `test/e2e/browse.e2e.ts`).

Request bodies must be JSON, because a plain web form cannot send JSON and so a form on another site
cannot post to the server. Errors are JSON with an `error` message and never include a stack trace.

## API

The package can also be embedded. Everything below is exported from the package root.

| Export                   | Description                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `main(options?)`         | Parses `argv`, starts the server (or runs `doctor`), and logs the URL. Takes `argv`, `env`, and a `log` sink |
| `createServer(options?)` | Creates an unstarted `http.Server`. Options: `webRoot`, `version`, `dataDir`, `env`, `log`                   |
| `DEFAULT_HOST`           | `'127.0.0.1'`                                                                                                |
| `DEFAULT_PORT`           | `4280`                                                                                                       |
| `DEFAULT_WEB_ROOT`       | Absolute path to this package's built frontend (`dist/web`)                                                  |

Types: `MainOptions`, `ServerOptions`, `HealthResponse`, and the API's JSON shapes: `ConnectionView`,
`ConnectionUpdate`, `DoctorReport`, `DoctorResult`, `ErrorResponse`.
