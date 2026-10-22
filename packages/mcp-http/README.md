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

| Option            | Default     | Does                                                                          |
| ----------------- | ----------- | ----------------------------------------------------------------------------- |
| `createMcpServer` | required    | Returns a new `McpServer` per request, given `{ apiKey }`                     |
| `port`            | required    | `0` picks a free port; read it back from `.port`                              |
| `host`            | `'0.0.0.0'` | `'127.0.0.1'` keeps it local                                                  |
| `basePath`        | `''`        | Also serve MCP on `<basePath>` and `<basePath>/mcp`, and `<basePath>/healthz` |
| `health`          | always ok   | Return `false` for a 503 on `/healthz`                                        |
| `apiKey`          | off         | Require the caller's key; `hint` is added to the 401 message                  |
| `oauth`           | off         | Let callers sign in with the upstream service; see [OAuth](#oauth)            |
| `logger`          | silent      | Anything with `error(obj, msg)`, such as pino                                 |

It returns `{ url, port, close() }`.

## API key

With `apiKey` set, every request to `/mcp` must carry the caller's own key for
the upstream API, in `X-Api-Key` or as `Authorization: Bearer <key>`
(`X-Api-Key` wins when both are present). Without one the server answers 401
before building an MCP server. The key reaches `createMcpServer` as
`apiKey`; it is never logged or stored. Other per-caller settings can travel
as headers of their own, read from `headers` in the same context.

This suits public servers where each user brings their own credentials: no
sessions, no database. In claude.ai, add the connector with
"No sign-in" and the key as a request header.

## OAuth

With `oauth` set, the server is also an OAuth 2.1 authorization server in front
of an upstream provider, so a client such as claude.ai can connect with a
sign-in instead of a pasted key. It needs `ENCRYPTION_KEY` (32 bytes, base64)
and keeps no state: client registrations, codes and tokens are sealed with that
key, and the upstream token travels inside the access token.

```ts
import { oauth2Upstream, startMcpHttpServer } from '@ultimatelemon-eu/mcp-http';

await startMcpHttpServer({
  createMcpServer: ({ apiKey, oauth }) => buildServer(apiKey, oauth?.settings),
  port: 3000,
  basePath: '/example',
  apiKey: {},
  oauth: {
    publicUrl: 'https://mcp.example.com',
    name: 'Example',
    upstream: oauth2Upstream({
      authorizeUrl: 'https://example.com/oauth/authorize',
      tokenUrl: 'https://example.com/oauth/token',
      clientId: process.env.EXAMPLE_CLIENT_ID ?? '',
      clientSecret: process.env.EXAMPLE_CLIENT_SECRET ?? '',
      scopes: ['read']
    }),
    settings: async (accessToken) => ({
      title: 'Choose an account',
      fields: [
        {
          name: 'account',
          label: 'Account',
          options: await accountsOf(accessToken)
        }
      ]
    })
  }
});
```

- Register `<publicUrl><basePath>/oauth/callback` as the redirect URI at the
  upstream provider.
- Clients register dynamically (RFC 7591) and must use PKCE (S256).
- `settings` is optional: a form shown once after the upstream sign-in, with
  radio or checkbox fields. Submitted values are checked against the options,
  and the answers reach `createMcpServer` as `oauth.settings` on every request.
- In `createMcpServer`, `apiKey` holds the upstream access token for both
  callers who signed in and callers who sent a key.
- Metadata is served on `<basePath>/.well-known/...` and on
  `/.well-known/oauth-authorization-server<basePath>` (and the protected
  resource equivalent). Behind a path-routing proxy, route those root paths to
  the server too.
- Access tokens last an hour, or less when the upstream token expires sooner;
  refresh tokens last 90 days and renew the upstream token when needed.
- Nothing can be revoked server-side: a user revokes the app at the upstream
  provider, and rotating `ENCRYPTION_KEY` signs everyone out. A code can be
  redeemed once per process.

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
