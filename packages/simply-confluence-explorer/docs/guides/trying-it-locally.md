---
title: Trying it locally
description: Run the app from its source against a Confluence of its own on your machine, so you can try it, change it or test it without touching your company's Confluence.
sidebar:
  order: 10
---

You do not need your company's Confluence to try Confluence Explorer or to work on it. The source
repository can start a real Confluence Data Center on your own machine, fill it with a small set of
test spaces, and run the app against it. Nothing you do there reaches any other Confluence, and your
own settings in `~/.confluence-explorer` are left alone.

## What you need

- **Node.js 22 or later**, and **Corepack**, which comes with Node.js and installs the right version
  of pnpm for you.
- **podman or docker**, to run Confluence and its database in containers. Confluence may use up to
  4 GB of memory, and its database a little more.
- **git**, to get the source.

## Get the source

```sh
corepack enable
git clone https://github.com/SimplySF/simply-confluence-explorer.git
cd simply-confluence-explorer
corepack install
pnpm install
```

`corepack enable` is needed once per machine. To try a change that is still in a pull request,
switch to its branch first, for example `git switch feat/my-change`, then run `pnpm install` again.

## Start a Confluence of your own

```sh
pnpm run testenv:start
```

The first start downloads Confluence and Postgres and sets them up, which takes a few minutes; later
starts take about a minute. It finishes by creating four test spaces, **PLAT**, **OPS**, **PEOPLE**
and **ENG**, with pages, labels, attachments and `.confluenceignore` rules, so every feature has
something to work on. The administrator account is `admin` with the password `admin`, and Confluence
itself is at `http://localhost:8090` if you want to look at the pages there.

Confluence runs on Atlassian's developer licence, which lasts three hours. `pnpm run testenv:status`
shows when it runs out; after that every write is refused, and `pnpm run testenv:down` followed by
`pnpm run testenv:start` restarts it with a new licence.

## Run the app against it

```sh
export $(node test-env/testenv.mjs env | xargs)
pnpm run dev
```

The first line points the app at your local Confluence, with a token it created, and gives it a data
folder of its own in `test-env/.state/data`. (`node test-env/testenv.mjs env` prints the four
variables it sets, if your shell needs them set another way.) Open `http://localhost:5173`. The app is already
connected, so you can sync a space, read pages, review them and push changes straight away. Changes
to the browser side of the code appear as you save them; changes to the server need `pnpm run dev`
to be started again.

For the AI features, choose a provider under **Settings → AI provider**. The settings are saved in
the test data folder, not in your own.

To try the app exactly as people install it, build it and run the packed copy instead, keeping the
same variables:

```sh
pnpm run build
cd packages/simply-confluence-explorer
pnpm pack
npx ./simplysf-simply-confluence-explorer-<version>.tgz
```

and open the address it prints.

## Run the tests

```sh
pnpm run build
pnpm test
pnpm run test:e2e
```

`pnpm test` is the fast suite, which needs no Confluence. `pnpm run test:e2e` runs against your
local Confluence, and skips itself when none is running.

## Stop or start again

| command                   | what it does                                                       |
| ------------------------- | ------------------------------------------------------------------ |
| `pnpm run testenv:status` | Shows whether Confluence is running and when its licence runs out. |
| `pnpm run testenv:down`   | Stops Confluence and keeps its pages for next time.                |
| `pnpm run testenv:reset`  | Deletes everything, so the next start begins with fresh pages.     |

Pages you change while trying the app stay changed until you reset. The test environment's own
README, `test-env/README.md`, explains how it works.

## How this is checked

The `e2e` workflow (`.github/workflows/e2e.yml`) runs `pnpm run testenv:start` and the end-to-end
suite on every pull request, so the steps above are run by CI as well as described here.
