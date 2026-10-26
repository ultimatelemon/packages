import * as client from 'openid-client';

import { cookie, hostCookieName } from './cookies.js';
import { safeReturnTo } from './return-to.js';
import { signSession, verifySession } from './session.js';

import type { CookieToSet } from './cookies.js';
import type { Session, SessionKeys } from './session.js';

export interface AuthConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  appUrl: string;
  sessionSecret: string;
  cookiePrefix?: string;
  callbackPath?: string;
  scope?: string;
  sessionMaxAgeSeconds?: number;
  // Accept a plain-http issuer, but only on a loopback hostname (`localhost`,
  // `127.0.0.1`, `[::1]`, or a `*.localhost` subdomain) — local dev only, and
  // enforced in code, not just by convention. Also ignored whenever
  // `NODE_ENV === 'production'`, so leaving this on by accident in a
  // deployed environment does not re-enable plaintext OIDC traffic.
  allowInsecureHttp?: boolean;
}

export interface LoginOptions {
  // Ask for credentials even when the identity provider has a session, e.g.
  // before revealing a secret. Check `session.authTime` after the callback.
  reauthenticate?: boolean;
}

export interface LoginStart {
  url: string;
  cookie: CookieToSet;
}

export interface LoginResult {
  session: Session;
  // The id_token claims, for a one-off decision at login such as mapping
  // Zitadel project roles. Never stored in the session.
  claims: Record<string, unknown>;
  returnTo: string;
  cookies: CookieToSet[];
}

export interface Auth {
  sessionCookieName: () => string;
  startLogin: (
    returnTo?: string | null,
    options?: LoginOptions
  ) => Promise<LoginStart>;
  finishLogin: (
    requestUrl: string,
    flowCookieValue: string | undefined
  ) => Promise<LoginResult>;
  readSession: (token: string | null | undefined) => Promise<Session | null>;
  logoutCookies: () => CookieToSet[];
  flowCookieName: () => string;
}

export type AuthErrorCode =
  | 'flow_expired'
  | 'discovery_failed'
  | 'exchange_failed'
  | 'no_identity'
  | 'profile_unreachable'
  | 'no_email';

/**
 * `cause` (and `stack`) can carry the raw error from the identity provider,
 * e.g. a token-endpoint response or userinfo claims. Do not log or render
 * this error as-is; use `describeAuthError()` for a safe summary instead.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'AuthError';
    this.code = code;
  }
}

export interface AuthErrorInfo {
  name: 'AuthError';
  code: AuthErrorCode;
  message: string;
}

/**
 * Safe to log or render: unlike `error.cause`, this never carries the raw
 * identity-provider response. Returns `null` for anything that is not an
 * `AuthError`.
 */
export function describeAuthError(error: unknown): AuthErrorInfo | null {
  if (!(error instanceof AuthError)) return null;
  return { name: 'AuthError', code: error.code, message: error.message };
}

const DEFAULT_MAX_AGE = 14 * 24 * 60 * 60;
const FLOW_MAX_AGE = 10 * 60;

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

function parseFlow(raw: string | undefined): Flow | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const flow = value as Record<string, unknown>;
    const fields = ['state', 'nonce', 'verifier', 'returnTo'] as const;
    if (!fields.every((f) => typeof flow[f] === 'string' && flow[f])) {
      return null;
    }
    return flow as unknown as Flow;
  } catch {
    return null;
  }
}

function text(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// A loopback hostname is what makes `allowInsecureHttp` actually "local dev
// only": localhost, 127.0.0.1/[::1], and *.localhost subdomains. Compared
// against `URL#hostname`, which `new URL()` already lowercases and
// normalizes (alternate IPv4 notations collapse to `127.0.0.1`), so a plain
// allowlist check is enough — no `net.isIP`, no DNS lookups. Note that
// `URL#hostname` keeps the brackets for an IPv6 literal (e.g.
// `new URL('http://[::1]:8080').hostname === '[::1]'`), unlike e.g.
// `net.isIP()` or a socket's `remoteAddress`, which are bracket-free. This
// only checks the issuer itself: a loopback issuer whose discovery document
// points at a non-loopback token/jwks endpoint is not covered here.
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

export function createAuth(options: AuthConfig | (() => AuthConfig)): Auth {
  const resolve = typeof options === 'function' ? options : () => options;
  let discovered: Promise<client.Configuration> | null = null;

  function settings(): Required<AuthConfig> {
    const config = resolve();
    return {
      cookiePrefix: 'ul',
      callbackPath: '/api/auth/callback',
      scope: 'openid profile email',
      sessionMaxAgeSeconds: DEFAULT_MAX_AGE,
      allowInsecureHttp: false,
      ...config
    };
  }

  function keys(): SessionKeys {
    const s = settings();
    return {
      secret: s.sessionSecret,
      audience: s.appUrl,
      maxAgeSeconds: s.sessionMaxAgeSeconds
    };
  }

  function configuration(): Promise<client.Configuration> {
    if (!discovered) {
      const s = settings();
      const issuer = new URL(s.issuer);
      // A local Zitadel runs on plain http. Only allowed when the consumer
      // opts in explicitly via `allowInsecureHttp` — a missing/unknown
      // NODE_ENV must never open this up on its own (default-deny) — and
      // never in production, regardless of that flag, so a misconfigured
      // http issuer in production fails loudly instead. Also restricted to a
      // loopback issuer hostname, so "local dev only" is a guarantee rather
      // than a comment: a plain-http issuer on any other host (a Docker
      // network address, an internal hostname, ...) is rejected the same way
      // as any other disallowed http issuer, below.
      const insecure =
        issuer.protocol === 'http:' &&
        isLoopbackHost(issuer.hostname) &&
        s.allowInsecureHttp === true &&
        process.env.NODE_ENV !== 'production';
      discovered = client
        .discovery(
          issuer,
          s.clientId,
          s.clientSecret,
          undefined,
          insecure ? { execute: [client.allowInsecureRequests] } : undefined
        )
        .catch((error: unknown) => {
          discovered = null;
          throw new AuthError('discovery_failed', { cause: error });
        });
    }
    return discovered;
  }

  // Joined as strings: `new URL('/api/...', appUrl)` would drop a base path.
  function callbackUrl(): string {
    const s = settings();
    return `${s.appUrl.replace(/\/$/, '')}${s.callbackPath}`;
  }

  // Behind a reverse proxy the request URL is the internal one. The token
  // request must repeat the exact redirect_uri of the authorize request, or
  // Zitadel answers `invalid_grant: redirect_uri does not correspond`.
  function callbackUrlFor(requestUrl: string): URL {
    const url = new URL(callbackUrl());
    url.search = new URL(requestUrl).search;
    return url;
  }

  const flowCookieName = (): string =>
    hostCookieName(settings().cookiePrefix, 'oidc');
  const sessionCookieName = (): string =>
    hostCookieName(settings().cookiePrefix, 'session');

  async function startLogin(
    returnTo?: string | null,
    options: LoginOptions = {}
  ): Promise<LoginStart> {
    const config = await configuration();
    const verifier = client.randomPKCECodeVerifier();
    const flow: Flow = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier,
      returnTo: safeReturnTo(returnTo)
    };

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: callbackUrl(),
      scope: settings().scope,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
      ...(options.reauthenticate ? { prompt: 'login' } : {})
    });

    return {
      url: url.toString(),
      cookie: cookie(flowCookieName(), JSON.stringify(flow), FLOW_MAX_AGE)
    };
  }

  // Zitadel leaves profile claims out of the id_token unless "User Info inside
  // ID Token" is enabled per app, so fall back to the userinfo endpoint.
  async function readProfile(
    config: client.Configuration,
    claims: Record<string, unknown>,
    accessToken: string,
    sub: string
  ): Promise<{ email: string | null; name: string | null }> {
    const fromToken = {
      email: text(claims, 'email'),
      name: text(claims, 'name')
    };
    if (fromToken.email) return fromToken;

    const info = (await client.fetchUserInfo(
      config,
      accessToken,
      sub
    )) as unknown as Record<string, unknown>;
    return {
      email: text(info, 'email'),
      name: text(info, 'name') ?? fromToken.name
    };
  }

  async function finishLogin(
    requestUrl: string,
    flowCookieValue: string | undefined
  ): Promise<LoginResult> {
    const flow = parseFlow(flowCookieValue);
    if (!flow) throw new AuthError('flow_expired');

    const config = await configuration();
    // Computed outside the try below, like `settings()`/`resolve()` calls
    // elsewhere in this file (`configuration()`, `startLogin()`): it calls
    // the consumer's `resolve()` config function via `callbackUrl()` ->
    // `settings()`, so a throw from that function (or from `new URL()` on a
    // malformed `requestUrl`) must propagate unwrapped, not get mislabeled
    // as `exchange_failed`. Only `client.authorizationCodeGrant()` itself is
    // allowed to produce `exchange_failed`.
    //
    // Keep this line AFTER `await configuration()`, not before: a malformed
    // `requestUrl` makes this line throw on its own (via `new URL()`), and
    // if that happened before discovery had a chance to run, a discovery
    // failure that would also occur on this call would never get reported as
    // `discovery_failed` -- the raw `TypeError` from here would win instead
    // just because it runs first. Placing it after
    // `configuration()` guarantees discovery_failed keeps priority, exactly
    // like it already does ahead of `exchange_failed`. See the "ordering
    // regression" test in auth.test.ts.
    const redirectUri = callbackUrlFor(requestUrl);

    let tokens: client.TokenEndpointResponse &
      client.TokenEndpointResponseHelpers;
    try {
      tokens = await client.authorizationCodeGrant(config, redirectUri, {
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        pkceCodeVerifier: flow.verifier,
        idTokenExpected: true
      });
    } catch (error) {
      throw new AuthError('exchange_failed', { cause: error });
    }

    const claims = tokens.claims();
    if (!claims?.sub) throw new AuthError('no_identity');

    let profile: { email: string | null; name: string | null };
    try {
      profile = await readProfile(
        config,
        claims,
        tokens.access_token,
        claims.sub
      );
    } catch (error) {
      throw new AuthError('profile_unreachable', { cause: error });
    }
    if (!profile.email) throw new AuthError('no_email');

    const session: Session = {
      sub: claims.sub,
      email: profile.email,
      name: profile.name,
      authTime:
        typeof claims.auth_time === 'number'
          ? claims.auth_time
          : Math.floor(Date.now() / 1000)
    };
    const k = keys();
    const token = await signSession(session, k);

    return {
      session,
      claims: { ...claims },
      returnTo: flow.returnTo,
      cookies: [
        cookie(flowCookieName(), '', 0),
        cookie(sessionCookieName(), token, k.maxAgeSeconds)
      ]
    };
  }

  return {
    sessionCookieName,
    flowCookieName,
    startLogin,
    finishLogin,
    readSession: (token) => verifySession(token, keys()),
    logoutCookies: () => [
      cookie(sessionCookieName(), '', 0),
      cookie(flowCookieName(), '', 0)
    ]
  };
}
