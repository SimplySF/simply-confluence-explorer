# @simplysf/simply-confluence-explorer

A local web app for browsing and exploring Confluence, packaged as a Node.js CLI. Part of the
[`simply-confluence-explorer`](https://github.com/SimplySF/simply-confluence-explorer) monorepo.

> **Status:** framework only. The server and frontend are wired together, but there are no
> Confluence features yet.

## Usage

```sh
npx @simplysf/simply-confluence-explorer
# Confluence Explorer is running at http://127.0.0.1:4280/
```

| Option             | Environment | Default     | Description                                    |
| ------------------ | ----------- | ----------- | ---------------------------------------------- |
| `-p`, `--port <n>` | `PORT`      | `4280`      | Port to listen on; `0` picks a free port       |
| `--host <host>`    | `HOST`      | `127.0.0.1` | Interface to bind; set explicitly to expose it |
| `-h`, `--help`     |             |             | Show usage                                     |

A flag wins over its environment variable. The server listens on localhost only unless you pass
`--host`. It will hold Confluence credentials, so think twice before exposing it on a network.

## HTTP routes

| Route             | Description                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| `GET /api/health` | `{ "status": "ok", "version": "<package version>" }`                    |
| `/api/*`          | Anything else under `/api` is a JSON `404`, never the app shell         |
| everything else   | The built frontend, falling back to `index.html` for client-side routes |

## API

The package can also be embedded. Everything below is exported from the package root.

| Export                   | Description                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `main(options?)`         | Parses `argv`, starts the server, and logs the URL. Takes `argv`, `env`, and a `log` sink |
| `createServer(options?)` | Creates an unstarted `http.Server`. Options: `webRoot`, `version`                         |
| `DEFAULT_HOST`           | `'127.0.0.1'`                                                                             |
| `DEFAULT_PORT`           | `4280`                                                                                    |
| `DEFAULT_WEB_ROOT`       | Absolute path to this package's built frontend (`dist/web`)                               |

Types: `MainOptions`, `ServerOptions`, `HealthResponse`.
