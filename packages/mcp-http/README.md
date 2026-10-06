# @ultimatelemon-eu/mcp-http

Runs an [MCP](https://modelcontextprotocol.io) server over Streamable HTTP in
stateless mode: `POST /mcp`, `GET /healthz`, an optional base path for a proxy,
and a JSON-RPC 500 instead of a stack trace when a handler throws. Everything
else is your tools.

```bash
npm install @ultimatelemon-eu/mcp-http @modelcontextprotocol/sdk
```

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startMcpHttpServer } from '@ultimatelemon-eu/mcp-http';

function createMcpServer() {
  const server = new McpServer({ name: 'my-mcp', version: '1.0.0' });
  server.registerTool('ping', { description: 'Replies pong' }, () => ({
    content: [{ type: 'text', text: 'pong' }]
  }));
  return server;
}

const http = await startMcpHttpServer({
  createMcpServer,
  port: Number(process.env.PORT ?? 3000)
});

process.once('SIGTERM', () => void http.close().then(() => process.exit(0)));
```

## Options

| Option            | Default     | Does                                                 |
| ----------------- | ----------- | ---------------------------------------------------- |
| `createMcpServer` | required    | Returns a new `McpServer`; called once per request   |
| `port`            | required    | `0` picks a free port; read it back from `.port`     |
| `host`            | `'0.0.0.0'` | `'127.0.0.1'` keeps it local                         |
| `basePath`        | `''`        | Also serve `<basePath>/mcp` and `<basePath>/healthz` |
| `health`          | always ok   | Return `false` for a 503 on `/healthz`               |
| `logger`          | silent      | Anything with `error(obj, msg)`, such as pino        |

It returns `{ url, port, close() }`.

## Why stateless

A new server and transport per request means no session table, so it does not
matter which replica a request lands on and a restart loses nothing. The
price: no server-initiated messages and no `GET` stream, which is why `GET` and
`DELETE` on `/mcp` answer 405. Tools that read and return data do not need
either.

Keep shared state, such as an API client, a cache or a loaded list, outside
`createMcpServer` and close over it, so a request only builds the thin server.

## Auth

There is none. Put the server behind an authenticating proxy (Airlock, for the
UltimateLemon MCPs) or keep it on localhost.
