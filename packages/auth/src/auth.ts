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
  // Accept a plain-http issuer (local dev only). Ignored whenever
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
 * `cause` is a filtered `{ name, code? }` summary of whatever failed
 * upstream (see `describeCause()`), never the raw identity-provider error —
 * it is safe to log or render as-is. Use `describeAuthError()` if you only
 * want the flat `{ name, code, message }` shape and don't need `cause` at
 * all.
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

/**
 * Filters an unknown thrown value down to an allowlist safe to put in
 * `AuthError.cause`: the error's `name`, and its `code` if present and a
 * string. Never the `message` or any other property — those are where
 * openid-client/oauth4webapi errors carry the token-endpoint or userinfo
 * response body, up to and including token material. `code` itself is safe:
 * on these error classes it is a fixed library constant (e.g.
 * `OAUTH_RESPONSE_BODY_ERROR`), not something taken from the response.
 * Mirrors `describeOidcError()` in accounts' own (separate) copy of this
 * logic.
 */
function describeCause(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: typeof error };
  const name = error.name;
  const code =
    'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code !== undefined ? { name, code } : { name };
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
      // `settings()` runs the consumer's own config function (e.g. reading
      // env vars) — a throw from there (a missing env var) is the
      // consumer's problem, not a discovery failure, so it must propagate
      // unchanged rather than being reported as `discovery_failed`.
      const s = settings();

      let issuer: URL;
      try {
        issuer = new URL(s.issuer);
      } catch (error) {
        throw new AuthError('discovery_failed', {
          cause: describeCause(error)
        });
      }

      // A local Zitadel runs on plain http. Only allowed when the consumer
      // opts in explicitly via `allowInsecureHttp` — a missing/unknown
      // NODE_ENV must never open this up on its own (default-deny) — and
      // never in production, regardless of that flag, so a misconfigured
      // http issuer in production fails loudly instead.
      const insecure =
        issuer.protocol === 'http:' &&
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
          throw new AuthError('discovery_failed', {
            cause: describeCause(error)
          });
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

    let tokens: client.TokenEndpointResponse &
      client.TokenEndpointResponseHelpers;
    try {
      tokens = await client.authorizationCodeGrant(
        config,
        callbackUrlFor(requestUrl),
        {
          expectedState: flow.state,
          expectedNonce: flow.nonce,
          pkceCodeVerifier: flow.verifier,
          idTokenExpected: true
        }
      );
    } catch (error) {
      throw new AuthError('exchange_failed', { cause: describeCause(error) });
    }

    let claims: client.IDToken | undefined;
    try {
      claims = tokens.claims();
    } catch (error) {
      // Reuses the existing `no_identity` code rather than adding a new
      // `AuthErrorCode`: it already means "no usable identity came out of
      // the token exchange", which covers both a missing `sub` (below) and
      // a token whose claims could not be read at all.
      throw new AuthError('no_identity', { cause: describeCause(error) });
    }
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
      throw new AuthError('profile_unreachable', {
        cause: describeCause(error)
      });
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
