# @ultimatelemon-eu/auth

Zitadel login for UltimateLemon apps: the OIDC authorization code flow with
PKCE, and a signed session cookie. It takes and returns plain values and
cookies, so it works in any framework; the Next.js wiring is ten lines.

```bash
npm install @ultimatelemon-eu/auth
```

Replaces the copies of `oidc.ts` and `session.ts` in `accounts` and `nova-v2`.

## Setup

```ts
// src/lib/auth.ts
import 'server-only';

import { createAuth } from '@ultimatelemon-eu/auth';

export const auth = createAuth(() => ({
  issuer: process.env.OIDC_ISSUER ?? '',
  clientId: process.env.OIDC_CLIENT_ID ?? '',
  clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
  appUrl: process.env.APP_URL ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? '',
  cookiePrefix: 'myapp'
}));
```

Pass a function: nothing is read until the first login or session check, so
`next build` without env does not fail on an import.

| Option                 | Default                  | Does                                                                                 |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `issuer`               | required                 | Zitadel instance URL                                                                 |
| `clientId`             | required                 | OIDC client id                                                                       |
| `clientSecret`         | required                 | OIDC client secret                                                                   |
| `appUrl`               | required                 | Public URL of the app, including base path                                           |
| `sessionSecret`        | required                 | HS256 key for the session, 32+ characters                                            |
| `cookiePrefix`         | `'ul'`                   | Cookies become `__Host-<prefix>_session`                                             |
| `callbackPath`         | `'/api/auth/callback'`   | Register `appUrl + callbackPath` in Zitadel                                          |
| `scope`                | `'openid profile email'` |                                                                                      |
| `sessionMaxAgeSeconds` | 14 days                  | After this, back through Zitadel                                                     |
| `allowInsecureHttp`    | `false`                  | Allow a plain-http issuer (local dev only; ignored when `NODE_ENV === 'production'`) |

## Next.js

```ts
// src/app/api/auth/login/route.ts
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

export async function GET(request: Request): Promise<never> {
  const next = new URL(request.url).searchParams.get('next');
  const { url, cookie } = await auth.startLogin(next);
  (await cookies()).set(cookie.name, cookie.value, cookie.options);
  redirect(url);
}
```

```ts
// src/app/api/auth/callback/route.ts
export async function GET(request: Request): Promise<never> {
  const store = await cookies();
  const result = await auth.finishLogin(
    request.url,
    store.get(auth.flowCookieName())?.value
  );
  for (const c of result.cookies) store.set(c.name, c.value, c.options);
  redirect(result.returnTo);
}
```

```ts
// anywhere on the server
const session = await auth.readSession(
  (await cookies()).get(auth.sessionCookieName())?.value
);
```

`startLogin` and `finishLogin` throw an `AuthError` with a `code` on a
discovery failure: `discovery_failed`. `finishLogin` additionally throws
`flow_expired`, `exchange_failed`, `no_identity`, `profile_unreachable` or
`no_email`. `no_identity` covers both a token response with no usable `sub`
and a token whose claims could not be read at all. Catch it in the login route
and the callback and show a page instead of a stack trace.

`cause` is already safe to log: for every code that can come from an upstream
call (`discovery_failed`, `exchange_failed`, `no_identity`,
`profile_unreachable`), it is a filtered `{ name, code? }` summary of whatever
failed, never the raw identity-provider response, claims or token material.
There is nothing to redact before logging `error.cause` or the whole
`AuthError`. `describeAuthError()` remains the recommended way to get a flat
summary, since it also covers `flow_expired` and `no_email` without needing to
know which codes carry a `cause`:

```ts
import { describeAuthError } from '@ultimatelemon-eu/auth';

try {
  const result = await auth.finishLogin(request.url, flowCookie);
  // ...set result.cookies, redirect to result.returnTo
} catch (error) {
  logger.error(describeAuthError(error), 'login failed');
  // { name: 'AuthError', code: 'exchange_failed', message: 'exchange_failed' }
}
```

| Function                   | Returns                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `describeAuthError(error)` | `{ name, code, message }` for an `AuthError`, `null` otherwise |

`readSession` checks signature, expiry, issuer and audience, and returns
`null` on any doubt. It uses `jose` only, so a `proxy.ts` can call it.

A session is `{ sub, email, name, authTime }`, where `sub` is the Zitadel
user id and `authTime` (seconds) is when the user last entered credentials.
Permissions do not belong in it: read them per request, so revoking access
works immediately rather than when the token expires.

### Sensitive actions

Single sign-on can log a user in without asking for anything. Before showing
a secret, require a recent `authTime` and otherwise send the user through
Zitadel with `prompt=login`:

```ts
const fresh = session.authTime > Date.now() / 1000 - 10 * 60;
if (!fresh) {
  const { url, cookie } = await auth.startLogin(next, { reauthenticate: true });
  // set cookie, redirect to url
}
```

## What it gets right

- **Reverse proxy.** Behind Traefik the request URL is the internal one. The
  token request must repeat the exact `redirect_uri` of the authorize request,
  so it is rebuilt from `appUrl` with only the query string taken from the
  request. Otherwise Zitadel answers `invalid_grant: redirect_uri does not
correspond`.
- **Base path.** The callback URL is joined as a string; `new URL('/api/...',
appUrl)` would drop `/account` from `https://id.example/account`.
- **Profile claims.** Zitadel leaves email and name out of the id_token unless
  "User Info inside ID Token" is on, so it falls back to the userinfo
  endpoint.
- **Open redirects.** `returnTo` goes through the URL parser: `/\evil.example`
  passes a string check for `//` but resolves to another origin.
- **Local http.** A plain-http issuer is rejected unless the consumer opts in
  with `allowInsecureHttp: true` — and never in production, regardless of that
  flag. Without the opt-in, discovery itself fails against a plain-http
  issuer, surfacing as `AuthError('discovery_failed')` like any other
  discovery failure.
- **Discovery** is cached per process, and retried after a failure.
