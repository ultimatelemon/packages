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
  startLogin: (returnTo?: string | null) => Promise<LoginStart>;
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
  | 'exchange_failed'
  | 'no_identity'
  | 'profile_unreachable'
  | 'no_email';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'AuthError';
    this.code = code;
  }
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
      // A local Zitadel runs on plain http. Allowed only outside production,
      // so a misconfigured http issuer in production fails loudly instead.
      const insecure =
        issuer.protocol === 'http:' && process.env.NODE_ENV !== 'production';
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
          throw error;
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

  async function startLogin(returnTo?: string | null): Promise<LoginStart> {
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
      nonce: flow.nonce
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
      name: profile.name
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
