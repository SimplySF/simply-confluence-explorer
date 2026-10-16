# Simply Confluence Explorer

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Simply Confluence Explorer is a local web app built by [SimplySF](https://github.com/SimplySF) for
browsing and exploring Confluence. It ships as a Node.js package: install it, run
`confluence-explorer`, and open the URL it prints.

> **Status:** framework only. The server and frontend are wired end to end, but there are no
> Confluence features yet. See [docs/design](docs/design/README.md) for what is planned.

**Maintenance:** maintained by the team that uses it against its Confluence, for as long as it does.

## Packages

| Package                                                                       | Description                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| [`@simplysf/simply-confluence-explorer`](packages/simply-confluence-explorer) | The web app: a Node server and its Svelte frontend |

## Usage

```sh
npx @simplysf/simply-confluence-explorer
# Confluence Explorer is running at http://127.0.0.1:4280/
```

Requires Node.js 22 or later. See the [package README](packages/simply-confluence-explorer/README.md)
for options.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the repo structure, how to set
up and build the project, our commit conventions, and how to submit a pull request. Please also read
our [Code of Conduct](CODE_OF_CONDUCT.md).

## Issues

Please report bugs or request features by
[opening an issue](https://github.com/SimplySF/simply-confluence-explorer/issues) in this repository.

## License

Licensed under the [Apache-2.0](LICENSE.txt) license.
