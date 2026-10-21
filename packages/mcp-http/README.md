# @ultimatelemon-eu/mcp-http

Runs an [MCP](https://modelcontextprotocol.io) server over Streamable HTTP in
stateless mode: `POST /mcp`, `GET /healthz`, an optional base path for a proxy,
an optional API key the caller brings, and a JSON-RPC 500 instead of a stack
trace when a handler throws. Everything else is your tools.

```bash
npm install @ultimatelemon-eu/mcp-http @modelcontextprotocol/server @modelcontextprotocol/node
```

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { startMcpHttpServer } from '@ultimatelemon-eu/mcp-http';

const http = await startMcpHttpServer({
  createMcpServer: ({ apiKey }) => {
    const server = new McpServer({ name: 'my-mcp', version: '1.0.0' });
    server.registerTool('ping', { description: 'Replies pong' }, () => ({
      content: [{ type: 'text', text: `pong for ${apiKey}` }]
    }));
    return server;
  },
  port: Number(process.env.PORT ?? 3000),
  apiKey: { hint: 'Create one at https://example.com/keys.' }
});

process.once('SIGTERM', () => {
  void http.close().then(
    () => process.exit(0),
    () => process.exit(0)
  );
});
```

## Options

| Option            | Default     | Does                                                         |
| ----------------- | ----------- | ------------------------------------------------------------ |
| `createMcpServer` | required    | Returns a new `McpServer` per request, given `{ apiKey }`    |
| `port`            | required    | `0` picks a free port; read it back from `.port`             |
| `host`            | `'0.0.0.0'` | `'127.0.0.1'` keeps it local                                 |
| `basePath`        | `''`        | Also serve `<basePath>/mcp` and `<basePath>/healthz`         |
| `health`          | always ok   | Return `false` for a 503 on `/healthz`                       |
| `apiKey`          | off         | Require the caller's key; `hint` is added to the 401 message |
| `logger`          | silent      | Anything with `error(obj, msg)`, such as pino                |

It returns `{ url, port, close() }`.

## API key

With `apiKey` set, every request to `/mcp` must carry the caller's own key for
the upstream API, in `X-Api-Key` or as `Authorization: Bearer <key>`
(`X-Api-Key` wins when both are present). Without one the server answers 401
before building an MCP server. The key reaches `createMcpServer` as
`apiKey`; it is never logged or stored.

This suits public servers where each user brings their own credentials: no
OAuth, no sessions, no database. In claude.ai, add the connector with
"No sign-in" and the key as a request header.

## Why stateless

A new server per request means no session table, so it does not matter which
replica a request lands on and a restart loses nothing. The price: no
server-initiated messages outside a request and no `GET` stream, which is why
`GET` and `DELETE` on `/mcp` answer 405. Tools that read and return data do not
need either.

Keep shared state, such as a cache or a loaded list, outside `createMcpServer`
and close over it, so a request only builds the thin server.

## Upgrading from 1.x

- The MCP SDK moved to v2: replace `@modelcontextprotocol/sdk` with
  `@modelcontextprotocol/server` and `@modelcontextprotocol/node`, and import
  `McpServer` from `@modelcontextprotocol/server`.
- `createMcpServer` receives a context object and may return a promise.
