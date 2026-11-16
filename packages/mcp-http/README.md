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
| `apiKey`          | off         | Require the caller's key; `hint` is added to the 401, `verify` checks it      |
| `oauth`           | off         | Let callers sign in with the upstream service; see [OAuth](#oauth)            |
| `pages`           | none        | Extra pages under `<basePath>/`; see [Pages](#pages)                          |
| `logger`          | silent      | Anything with `error(obj, msg)`, such as pino                                 |

It returns `{ url, port, close() }`.

## API key

With `apiKey` set, every request to `/mcp` must carry the caller's own key for
the upstream API, in `X-Api-Key` or as `Authorization: Bearer <key>`
(`X-Api-Key` wins when both are present). Without one the server answers 401
before building an MCP server. The key reaches `createMcpServer` as
`apiKey`; it is never logged or stored. Other per-caller settings can travel
as headers of their own, read from `headers` in the same context.

When the server hands out keys itself, `verify` checks one before any MCP
work: return `false` and the caller gets a 401 with `error="invalid_token"`.

```ts
apiKey: {
  verify: (key) => findUserByToken(key) !== undefined;
}
```

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
- Clients identify themselves with a Client ID Metadata Document (CIMD) or
  register dynamically (RFC 7591), and must use PKCE (S256). See
  [Clients](#clients).
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

### Clients

claude.ai and Claude Code use a Client ID Metadata Document: the `client_id`
is the URL of a JSON document that lists the client's redirect URIs, such as
`https://claude.ai/oauth/mcp-oauth-client-metadata`. In claude.ai that is the
"Use Claude's published identity" option, which it picks by itself once the
metadata says `client_id_metadata_document_supported`.

| Option             | Default                           | Does                                                      |
| ------------------ | --------------------------------- | --------------------------------------------------------- |
| `clientIdMetadata` | `{ trustedHosts: ['claude.ai'] }` | Hosts whose documents are fetched; `false` turns CIMD off |
| `registration`     | `true`                            | Dynamic client registration on `<basePath>/register`      |

- Only documents on `trustedHosts` are fetched, so a `client_id` cannot make
  the server request an arbitrary URL. The `client_id` must be the canonical
  https URL with a path; redirects are not followed, the fetch times out after
  5 seconds and documents over 16 KiB are refused. A document must name the
  same `client_id`, list its `redirect_uris` and be a public client
  (`token_endpoint_auth_method` `none`). Documents are cached for 5 minutes.
- Anyone can register through DCR with any redirect URI, and the upstream
  sign-in may pass without a prompt when the user already has a session there.
  For a server with private data, set `registration: false` and accept only
  the clients on `trustedHosts`.

### OpenID Connect upstream

`oidcUpstream` signs users in with an OpenID Connect provider such as Zitadel,
with PKCE toward the provider. Whoever signed in reaches `createMcpServer` as
`oauth.subject` (the `sub` claim).

```ts
import { oidcUpstream } from '@ultimatelemon-eu/mcp-http';

const upstream = oidcUpstream({
  issuer: 'https://id.example.com',
  clientId: process.env.OIDC_CLIENT_ID ?? '',
  clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
  scopes: ['openid', 'offline_access']
});
```

| Option                    | Default              | Does                                                        |
| ------------------------- | -------------------- | ----------------------------------------------------------- |
| `issuer`                  | required             | https only; discovered once, retried after a failure        |
| `clientId`                | required             | A confidential client at the provider                       |
| `clientSecret`            | required             |                                                             |
| `scopes`                  | `['openid']`         | Add `offline_access` for an upstream refresh token          |
| `tokenEndpointAuthMethod` | `client_secret_post` | Or `client_secret_basic`; must match the provider's setting |

- The id_token comes straight from the token endpoint over TLS, so its
  signature is not checked (OIDC Core 3.1.3.7); its issuer, audience,
  authorized party, expiry and subject are.
- A refresh renews the upstream token when it is about to expire, which is
  when a user who lost access at the provider is turned away. Without
  `offline_access` (in Zitadel: the Refresh Token grant on the app), the user
  signs in again once the upstream token expires. A refresh that comes back
  for another subject is refused.
- `oauth2Upstream` takes `pkce: true` for a plain OAuth provider that supports
  PKCE.

### Other frameworks

`@ultimatelemon-eu/mcp-http/oauth` exports `createOAuthHandler` without the
Node HTTP server, for a framework that routes requests itself, such as a
Next.js route handler. It takes web `Request`s and returns `Response`s.

```ts
// src/lib/mcp-oauth.ts
import {
  createOAuthHandler,
  oidcUpstream
} from '@ultimatelemon-eu/mcp-http/oauth';

let handler: ReturnType<typeof createOAuthHandler> | undefined;

// Lazily: creating it checks ENCRYPTION_KEY, which `next build` does not have.
export function mcpOAuth() {
  handler ??= createOAuthHandler(
    {
      publicUrl: process.env.APP_URL ?? '',
      name: 'Example',
      upstream: oidcUpstream({/* ... */}),
      registration: false
    },
    '/api/mcp'
  );
  return handler;
}
```

- Send every request for a path that `owns(path)` accepts to `handle`: the
  routes under `<basePath>/` (`authorize`, `token`, `oauth/callback`,
  `oauth/settings`, `.well-known/...`) and `/.well-known/oauth-protected-resource<basePath>`,
  `/.well-known/oauth-authorization-server<basePath>` and
  `/.well-known/openid-configuration<basePath>`.
- On the MCP endpoint itself, read the bearer token with `authenticate(token)`.
  It returns the grant, or `undefined`: answer 401 with
  `WWW-Authenticate: <challenge()>`, or `challenge('invalid_token')` when a
  token was sent.

## Pages

`pages` serves anything else under `<basePath>/`, such as a form the caller
opens in a browser. It gets a web `Request` (body capped at 64 KiB) and
returns a `Response`, or `undefined` for the usual 404. MCP, `/healthz` and
the OAuth routes are matched first and never reach it.

`htmlPage(title, body)` wraps markup in the layout of the sign-in pages, and
`htmlResponse(html, status)` sends it with `no-store` and a CSP that allows no
scripts and no framing. Escape anything you insert with `escapeHtml`.

```ts
pages: (request) => {
  if (new URL(request.url).pathname !== '/example/hello') return undefined;
  return htmlResponse(htmlPage('Hello', '<h1>Hello</h1>'), 200);
};
```

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
