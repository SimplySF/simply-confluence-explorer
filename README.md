# Simply Confluence Explorer

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Simply Confluence Explorer is a local web app built by [SimplySF](https://github.com/SimplySF) for
working with Confluence Server and Data Center. You run it on your own computer and use it in your
browser: browse a space, keep a copy of it on disk as Markdown, ask an AI about a page or a whole
space, and improve pages and push them back, with every write checked against the version it was
made from.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/simply-confluence-explorer/docs/images/overview-dark.webp">
  <img alt="Confluence Explorer showing a page from a Confluence space, with the page tree on the left" src="packages/simply-confluence-explorer/docs/images/overview-light.webp">
</picture>

It covers:

- **Browsing and reading:** a space's page tree, any page rendered, as Markdown, or in Confluence's
  storage format, and a jump box that opens a page from its address.
- **A copy on disk:** a whole space synced as Markdown files with their attachments, a table of
  contents, a ZIP export, and AI summaries of every page.
- **Asking an AI:** questions about a page, a page and everything under it, or a whole space, with
  files of your own added to the conversation. Claude, ChatGPT and Gemini are supported through their
  APIs, and Gemini also through its command-line tool.
- **Improving pages:** a proposed revision you review line by line, check with a dry run, and push,
  for one page or for every page in a branch through a review queue.
- **Writing new pages:** a check for existing pages that already cover the topic, then a draft written
  with an AI and created under its parent.

Your Confluence token and AI keys stay on your computer and never reach the browser. Pages you exclude
are never sent to an AI, and everything that is sent passes a leak guard that stops secrets and
replaces personal data first.

> **Status:** every feature in the [design docs](docs/design/README.md) is built. Every merge to
> `main` publishes a beta to npm under the `beta` tag (`.github/workflows/release.yml`). A stable
> release is published under `latest` once a second person approves the pull request that releases
> it (ADR-044). The AI features have so far run only against a stand-in for each provider, not with real
> provider keys.

**Maintenance:** maintained by the team that uses it against its Confluence, for as long as it does.

## Packages

| Package                                                                       | Description                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| [`@simplysf/simply-confluence-explorer`](packages/simply-confluence-explorer) | The web app: a Node server and its Svelte frontend |

## Installation

Confluence Explorer needs Node.js 22 or later, and a Confluence Server or Data Center instance with a
personal access token for your account. Atlassian Cloud is not supported.

Run it with `npx`, which downloads it the first time:

```sh
npx @simplysf/simply-confluence-explorer@beta
# Confluence Explorer is running at http://127.0.0.1:4280/
```

Open the address it prints, then connect to your Confluence under **Settings**. If something does not
work, the doctor checks your setup and says what to fix:

```sh
npx @simplysf/simply-confluence-explorer@beta doctor
```

## Documentation

The [documentation site](https://simplysf.github.io/simply-confluence-explorer/) has a
getting-started guide and a guide to each part of the app:

- [Get started](https://simplysf.github.io/simply-confluence-explorer/getting-started/)
- [Connecting to Confluence](https://simplysf.github.io/simply-confluence-explorer/guides/connecting/)
- [Keeping a copy on disk](https://simplysf.github.io/simply-confluence-explorer/guides/syncing-a-space/)
- [Asking an AI](https://simplysf.github.io/simply-confluence-explorer/guides/asking-ai/)
- [What leaves your computer](https://simplysf.github.io/simply-confluence-explorer/guides/data-safety/)
- [Improving a page](https://simplysf.github.io/simply-confluence-explorer/guides/improving-pages/)
- [Reviewing a branch](https://simplysf.github.io/simply-confluence-explorer/guides/branch-review/)
- [Writing a new page](https://simplysf.github.io/simply-confluence-explorer/guides/new-pages/)
- [Troubleshooting](https://simplysf.github.io/simply-confluence-explorer/guides/troubleshooting/)

The guides are written in [`packages/simply-confluence-explorer/docs/`](packages/simply-confluence-explorer/docs),
which is where to change them.

The [package README](packages/simply-confluence-explorer/README.md) lists every option, the HTTP
routes and the embedding API.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the repo structure, how to set
up and build the project, our commit conventions, and how to submit a pull request. Please also read
our [Code of Conduct](CODE_OF_CONDUCT.md).

## Issues

Please report bugs or request features by
[opening an issue](https://github.com/SimplySF/simply-confluence-explorer/issues) in this repository.

## License

Licensed under the [Apache-2.0](LICENSE.txt) license.
