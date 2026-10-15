# AGENTS.md

## Documentation map

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the pull-request checklist, then the
package's own `CONTRIBUTING.md` for what is specific to it. New features start as a design doc in
[docs/design/](docs/design/README.md).

## Working conventions

- `@simplysf/simply-confluence-explorer` is two halves in one package: a Node server in `src/`
  (compiled by `tsc` to `lib/`) and a Svelte frontend in `web/` (bundled by Vite to `dist/web/`). The
  server serves the bundle and owns every call to Atlassian; the browser only ever talks to the
  server's `/api/*` routes, so credentials never reach the page.
- Prefer `@simplysf/simply-atlassian-core` for Confluence access over a second client. Adding any
  runtime dependency needs discussion first.
- The server binds to `127.0.0.1` by default. Listening on another interface is an explicit opt-in.
- Read `process.env` only through an injectable `env` option, and give anything that writes output an
  injectable sink, so tests never need stubbed globals.
- Commits follow Conventional Commits; commitlint enforces it and Lerna versions from it.
