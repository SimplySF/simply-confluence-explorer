# Contributing to @simplysf/simply-confluence-explorer

The Confluence Explorer web app. This package is part of the [`simply-confluence-explorer`](https://github.com/SimplySF/simply-confluence-explorer) monorepo.

**Start with the [root CONTRIBUTING.md](https://github.com/SimplySF/simply-confluence-explorer/blob/main/CONTRIBUTING.md).** It covers repository structure, environment setup, commit conventions, versioning, CI, git hooks, and the pull request process — all of which apply here. This file covers only what is specific to this package.

## Working on this package

Run from this directory to target just this package:

```sh
pnpm run dev         # Node server on :4280 + Vite dev server on :5173 (open the Vite URL)
pnpm run build       # compile server + bundle web + svelte-check + lint
pnpm test            # the full gate CI runs
pnpm run test:only   # just the unit tests, skipping lint
pnpm start           # run the built app, as `confluence-explorer` would
```

## Layout

| Path   | What it is                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------- |
| `src/` | The Node server, compiled by `tsc` to `lib/`. Linted by ESLint; tested in `test/`.             |
| `web/` | The Svelte frontend and its Vite config, bundled to `dist/web/`. Type-checked by svelte-check. |
| `bin/` | The `confluence-explorer` entry point; a thin wrapper over `main()` in `src/cli.ts`.           |

The two halves meet only over HTTP. The browser calls the server's `/api/*` routes, and the server
owns every call to Atlassian, so credentials never reach the page. The server and frontend have
separate tsconfigs because they target different runtimes (Node vs. DOM). Don't import across
`src/` and `web/`; if both sides need a type, define the API shape once and share it deliberately.

`svelte`, `vite`, and friends are devDependencies: they only build `dist/web/`, which is what gets
published. The server has no runtime dependencies yet, and adding one is a design decision, not a
convenience.

## The public surface

The public surface is whatever [`src/index.ts`](src/index.ts) re-exports. Adding to it means adding
an export to `src/index.ts` **and** documenting it in [`README.md`](README.md)'s `## API` section.
`test/index.test.ts` asserts the exported-key list; update it deliberately when the surface changes.

## Tests

No pull request is accepted without tests covering the change. Server tests live in
[`test/`](test), run under [Vitest](https://vitest.dev/), and start a real server on an ephemeral
port against a temporary web root, so they never need a built frontend. `main()` takes `argv`, `env`,
and `log` as options, so nothing touches `process` globals.

## Reporting issues

Please [open an issue](https://github.com/SimplySF/simply-confluence-explorer/issues) rather than sending a pull request for anything non-trivial without prior discussion.
