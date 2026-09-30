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

| Option                 | Default                  | Does                                        |
| ---------------------- | ------------------------ | ------------------------------------------- |
| `issuer`               | required                 | Zitadel instance URL                        |
| `clientId`             | required                 | OIDC client id                              |
| `clientSecret`         | required                 | OIDC client secret                          |
| `appUrl`               | required                 | Public URL of the app, including base path  |
| `sessionSecret`        | required                 | HS256 key for the session, 32+ characters   |
| `cookiePrefix`         | `'ul'`                   | Cookies become `__Host-<prefix>_session`    |
| `callbackPath`         | `'/api/auth/callback'`   | Register `appUrl + callbackPath` in Zitadel |
| `scope`                | `'openid profile email'` |                                             |
| `sessionMaxAgeSeconds` | 14 days                  | After this, back through Zitadel            |

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

`finishLogin` throws an `AuthError` with a `code`: `flow_expired`,
`exchange_failed`, `no_identity`, `profile_unreachable` or `no_email`. Catch
it in the callback and show a page instead of a stack trace; the original
error is in `cause`.

`readSession` checks signature, expiry, issuer and audience, and returns
`null` on any doubt. It uses `jose` only, so a `proxy.ts` can call it.

A session is `{ sub, email, name }`, where `sub` is the Zitadel user id.
Permissions do not belong in it: read them per request, so revoking access
works immediately rather than when the token expires.

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
- **Local http.** A plain-http issuer is accepted only outside production.
- **Discovery** is cached per process, and retried after a failure.
