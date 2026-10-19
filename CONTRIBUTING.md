# Contributing

Thanks for your interest in contributing to Simply Confluence Explorer! This document covers the repo structure, how to get set up, and how to submit changes.

1. Please read our [Code of Conduct](CODE_OF_CONDUCT.md).
2. Create a new issue before starting significant work so we can keep track of what you're trying to add or fix, offer suggestions, and avoid duplicate effort.
3. Fork this repository.
4. [Set up your environment](#setup) and make sure you can build and test the affected package(s) locally.
5. Create a topic branch in your fork.
6. Make your change, following the [commit message format](#commit-messages) below.
7. Write tests for your change. No pull request will be accepted without tests covering the change.
8. Open a pull request against `main`. We'll review your code, suggest any needed changes, and merge it in.

## Repository Structure

This repository is a Lerna monorepo. Today it holds the web app itself; more packages (for example
a shared core library) can be added alongside it. Every package has its own `CONTRIBUTING.md`
covering what's specific to it — read this file first, then that one.

| Package                                                                       | Description                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| [`@simplysf/simply-confluence-explorer`](packages/simply-confluence-explorer) | The web app: a Node server and its Svelte frontend |

Tooling:

- **Package manager:** pnpm workspaces
- **Task orchestration:** Lerna v10 (independent versioning) + Wireit (per-package build caching)
- **Language:** TypeScript (ESM)
- **Frontend:** [Svelte 5](https://svelte.dev/) bundled by [Vite](https://vite.dev/)
- **Tests:** [Vitest](https://vitest.dev/)
- **Node:** ^22.13.0 || ^24.0.0 || ^26.0.0 (required by Lerna 10; the published packages only require >=22.0.0)

## Setup

This repo pins its pnpm version via the `packageManager` field in `package.json`. Use [Corepack](https://nodejs.org/api/corepack.html) (bundled with Node.js) to install that exact version rather than installing pnpm globally:

```sh
corepack enable
git clone git@github.com:SimplySF/simply-confluence-explorer.git
cd simply-confluence-explorer
corepack install   # installs the pnpm version pinned in package.json
pnpm install
pnpm run build
pnpm test
```

`corepack enable` only needs to be run once per machine. After that, Corepack transparently uses whatever version of pnpm is pinned in `package.json`, so every contributor and CI job runs the same version.

`pnpm install` at the root installs and links every workspace package and sets up git hooks automatically via husky.

To work on the app with hot reload, run:

```sh
pnpm run dev
```

That starts the Node server on `http://127.0.0.1:4280` and the Vite dev server on
`http://localhost:5173`, which proxies `/api` to it. Open the Vite URL; frontend edits hot-reload, while server edits
need a restart.

To try the packaged app the way users get it, build and pack it:

```sh
pnpm run build
cd packages/simply-confluence-explorer
pnpm pack
npx ./simplysf-simply-confluence-explorer-<version>.tgz
```

## Common Commands

Run from the repo root to target all packages:

```sh
pnpm run build       # lerna run build (compile server + bundle web + check + lint)
pnpm run dev         # run the server and the Vite dev server together
pnpm run compile     # lerna run compile
pnpm run lint        # lerna run lint
pnpm run test        # lerna run test
pnpm run test:only   # lerna run test:only
pnpm run format      # lerna run format
pnpm run reset       # clear node_modules, the lockfile, and all wireit/TS/ESLint caches
pnpm run reset:install  # same as reset, then reinstall dependencies
pnpm run budgets     # print the size and architecture budgets that pnpm test enforces
pnpm run standard    # the development-standard conformance check, if it sits beside the checkout
```

The documentation site in `site/` renders the guides from `packages/simply-confluence-explorer/docs/`
(ADR-043). Edit the guides there, not the copies the site makes. To see the site while you write:

```sh
pnpm --filter site run dev     # copies the guides in, then serves the site with live reload
pnpm --filter site run build   # the same build docs.yml runs
```

Run inside a single package directory to target just that package:

```sh
cd packages/simply-confluence-explorer
pnpm run build
pnpm test
```

## Adding a Dependency

To add a dependency to a specific package:

```sh
pnpm add <package> --filter @simplysf/simply-confluence-explorer
```

To add a root-level devDependency (e.g., a shared build tool):

```sh
pnpm add -w -D <package>
```

## Commit Messages

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint on commit). Lerna uses your commit types to decide which packages get versioned and how their `CHANGELOG.md` is generated.

```text
feat: add support for X
fix: correct handling of Y
docs: update README
chore: bump a dependency
```

If your change only affects one package, scope the commit to it, e.g. `feat(simply-confluence-explorer): add a space browser`.

## Pull Requests

- Keep pull requests focused on a single change where possible.
- Make sure `pnpm run build` and `pnpm test` pass before opening the PR. CI runs both across every package; the pre-push hook runs the same checks but scoped to packages changed since the last release tag (see [Git Hooks](#git-hooks)), so a passing push doesn't guarantee a passing PR if your branch touches a root-level config file (e.g. `tsconfig.json`, `eslint.config.mjs`) that no single package's directory reflects.
- Aim for high test coverage on new code.
- If you changed a package's public API, update its README's `## API` section and its `test/index.test.ts` in the same PR.
- New features start with a [design doc](docs/design/README.md).

## Versioning and Publishing

Versioning uses Lerna's independent mode — each package has its own version and releases separately,
with versions and changelogs derived from Conventional Commits.

`release.yml` publishes only releases, and every release is a pull request (ADR-044, ADR-045). A
merge to `main` that is not a release publishes nothing.

Run the workflow from the Actions tab with **stable** ticked. Lerna works out the next version from
the commits since the last release, and the workflow writes it and its changelog on a branch named
`release/<version>` and opens a pull request. Its description tells the reviewer what the app is and
links each load-bearing file to read. Someone other than the person who opened it approves it, and
merging it publishes the version to npm as `latest`. Before tagging, the workflow runs
`node scripts/release-gate.mjs check <version> <commit>`, which refuses the release unless the
merged pull request came from `release/<version>` and its last commit was approved by someone other
than its author.

Do not merge other pull requests while a release pull request is open. Whatever is on `main` when
it merges is what gets published, and its reviewer read the code as it was when it was opened.

Running the workflow by hand without **stable** ticked publishes a merged release that is missing
from npm, which finishes a run whose publish step failed. It goes through the same approval check
first.

The workflow pushes its version commits and tags, and opens the release pull request, with the
`PERSONAL_ACCESS_TOKEN` secret, which belongs to an account allowed to bypass the branch rules and
needs write access to the repository's contents and pull requests, and publishes to npm through trusted
publishing, so no npm token is stored in the repository.

## CI

| Workflow      | Trigger                                   | What it does                                                                                           |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `test.yml`    | Push to non-main branches                 | Runs `pnpm run build` + `pnpm test` on Linux and Windows (lts/\*, lts/-1)                              |
| `e2e.yml`     | Pull requests, or by hand                 | Starts the Confluence test environment and runs `pnpm run test:e2e` against it (ADR-038)               |
| `release.yml` | Push to `main`, or by hand                | Opens a release's pull request by hand, and publishes the release when it is merged (ADR-044, ADR-045) |
| `docs.yml`    | Changes to `site/` or the guides; by hand | Builds the documentation site, checks its links, and on `main` deploys it to GitHub Pages (ADR-043)    |

## Git Hooks

| Hook         | Command                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `pre-commit` | `lint-staged` — runs `prettier --write` on staged files                                       |
| `commit-msg` | `commitlint` — enforces conventional commit format                                            |
| `pre-push`   | `lerna run build --since --include-dependents && lerna run test --since --include-dependents` |

`pre-push` only builds/tests packages changed since the last release tag (plus their transitive
dependents) to keep the hook fast locally — CI (`test.yml`) always runs `pnpm run build` + `pnpm test`
across every package, so nothing changed here reduces what actually gates a merge.

Hooks are installed automatically on `pnpm install` via the `prepare: husky` script.

## Reporting Issues

Please report bugs or request features by [opening an issue](https://github.com/SimplySF/simply-confluence-explorer/issues) rather than submitting a PR without prior discussion for anything non-trivial.
