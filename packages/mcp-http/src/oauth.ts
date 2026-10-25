import { createHash, timingSafeEqual } from 'node:crypto';
import { decrypt, encrypt, isEncrypted } from '@ultimatelemon-eu/crypto';
import {
  errorPage,
  htmlResponse,
  settingsPage,
  type SettingsForm
} from './pages.js';
import type { OAuthUpstream, UpstreamTokens } from './upstream.js';

export interface OAuthOptions {
  /** Public origin, e.g. `https://mcp.example.com`. The issuer is this plus the base path. */
  publicUrl: string;
  /** Upstream service name for the pages, e.g. `Moneybird`. */
  name: string;
  upstream: OAuthUpstream;
  /** Asked once after the upstream sign-in; the answers travel inside the issued tokens. */
  settings?: (accessToken: string) => Promise<SettingsForm | undefined>;
}

export interface OAuthGrant {
  /** The upstream access token. */
  accessToken: string;
  settings: Record<string, string>;
}

export interface OAuthHandler {
  owns(path: string): boolean;
  handle(request: Request): Promise<Response>;
  /** Opens an access token this server issued; undefined when it is not one, or expired. */
  authenticate(token: string): OAuthGrant | undefined;
  /** `WWW-Authenticate` value that points a client at the metadata. */
  challenge(error?: string): string;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const UPSTREAM_LEEWAY_MS = 5 * 60 * 1000;
const COOKIE = 'mcp_oauth_state';

// Every value this server hands out is sealed with ENCRYPTION_KEY instead of
// stored, so no database is needed. `t` keeps one kind from passing as another.
interface Flow {
  c: string;
  r: string;
  s?: string;
  p: string;
}
interface ClientSeal {
  t: 'client';
  r: string[];
}
interface StateSeal extends Flow {
  t: 'state';
}
interface PendingSeal extends Flow {
  t: 'pending';
  u: UpstreamTokens;
}
interface CodeSeal extends Flow {
  t: 'code';
  u: UpstreamTokens;
  a: Record<string, string>;
}
interface AccessSeal {
  t: 'access';
  u: string;
  a: Record<string, string>;
}
interface RefreshSeal {
  t: 'refresh';
  c: string;
  u: UpstreamTokens;
  a: Record<string, string>;
}
type Seal =
  ClientSeal | StateSeal | PendingSeal | CodeSeal | AccessSeal | RefreshSeal;
// `i` binds a value to one issuer, for servers that share ENCRYPTION_KEY.
type Sealed = Seal & { i: string; x?: number };

function sealer(issuer: string) {
  return {
    seal: (value: Seal, ttlMs?: number): string => {
      const sealed: Sealed = {
        ...value,
        i: issuer,
        ...(ttlMs === undefined ? {} : { x: Date.now() + ttlMs })
      };
      return encrypt(JSON.stringify(sealed));
    },
    open: <T extends Seal['t']>(
      value: string | null | undefined,
      type: T
    ): Extract<Seal, { t: T }> | undefined => {
      if (!value || !isEncrypted(value)) return undefined;
      try {
        const parsed = JSON.parse(decrypt(value)) as Sealed;
        if (parsed.t !== type || parsed.i !== issuer) return undefined;
        if (parsed.x !== undefined && parsed.x < Date.now()) return undefined;
        return parsed as unknown as Extract<Seal, { t: T }>;
      } catch {
        return undefined;
      }
    }
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}

function oauthError(error: string, description: string, status = 400) {
  return json({ error, error_description: description }, status);
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  if (cookie) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

const LOOPBACK = ['127.0.0.1', '[::1]', 'localhost'];

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK.includes(url.hostname);
  } catch {
    return false;
  }
}

// Exact match, except that a loopback http uri may use any port (RFC 8252 7.3).
function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  try {
    const left = new URL(registered);
    const right = new URL(presented);
    return (
      left.protocol === 'http:' &&
      right.protocol === 'http:' &&
      LOOPBACK.includes(left.hostname) &&
      left.hostname === right.hostname &&
      left.pathname === right.pathname &&
      left.search === right.search
    );
  } catch {
    return false;
  }
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(
    createHash('sha256').update(verifier).digest('base64url')
  );
  const expected = Buffer.from(challenge);
  return (
    computed.length === expected.length && timingSafeEqual(computed, expected)
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readForm(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await request.text());
}

/** Validates submitted settings against the form; returns an error message instead when invalid. */
function readSettings(
  form: SettingsForm,
  body: URLSearchParams
): Record<string, string> | string {
  const settings: Record<string, string> = {};
  for (const field of form.fields) {
    const allowed = new Set(field.options.map((option) => option.value));
    const values = body.getAll(field.name);
    if (values.some((value) => !allowed.has(value))) {
      return `"${field.label}" has a value that is not on the list.`;
    }
    if (!field.multiple && values.length !== 1) {
      return `Choose one option for "${field.label}".`;
    }
    settings[field.name] = values.join(',');
  }
  return settings;
}

export function createOAuthHandler(
  options: OAuthOptions,
  basePath: string
): OAuthHandler {
  // Fails at startup rather than at the first sign-in when ENCRYPTION_KEY is missing or malformed.
  decrypt(encrypt('check'));

  const origin = options.publicUrl.replace(/\/+$/, '');
  const issuer = `${origin}${basePath}`;
  const { seal, open } = sealer(issuer);
  const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource`;
  const callbackUri = `${issuer}/oauth/callback`;
  const paths = {
    register: `${basePath}/register`,
    authorize: `${basePath}/authorize`,
    token: `${basePath}/token`,
    callback: `${basePath}/oauth/callback`,
    settings: `${basePath}/oauth/settings`
  };
  const resourcePaths = [
    `${basePath}/.well-known/oauth-protected-resource`,
    `/.well-known/oauth-protected-resource${basePath}`
  ];
  const serverPaths = new Set([
    `${basePath}/.well-known/oauth-authorization-server`,
    `${basePath}/.well-known/openid-configuration`,
    `/.well-known/oauth-authorization-server${basePath}`,
    `/.well-known/openid-configuration${basePath}`
  ]);
  const endpoints = new Set(Object.values(paths));

  // Codes are sealed, not stored, so this is what keeps one from being redeemed twice.
  const redeemed = new Map<string, number>();

  function remember(code: string): boolean {
    const now = Date.now();
    for (const [key, expires] of redeemed) {
      if (expires < now) redeemed.delete(key);
    }
    const key = sha256(code);
    if (redeemed.has(key)) return false;
    redeemed.set(key, now + CODE_TTL_MS);
    return true;
  }

  function isResourcePath(path: string): boolean {
    return resourcePaths.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`)
    );
  }

  function owns(path: string): boolean {
    return isResourcePath(path) || serverPaths.has(path) || endpoints.has(path);
  }

  function authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer,
      authorization_endpoint: `${origin}${paths.authorize}`,
      token_endpoint: `${origin}${paths.token}`,
      registration_endpoint: `${origin}${paths.register}`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256']
    };
  }

  async function register(request: Request): Promise<Response> {
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return oauthError('invalid_client_metadata', 'Body must be JSON.');
    }
    const uris = body.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      !uris.every(
        (uri): uri is string =>
          typeof uri === 'string' && isAllowedRedirectUri(uri)
      )
    ) {
      return oauthError(
        'invalid_redirect_uri',
        'redirect_uris must be https uris or loopback http uris.'
      );
    }
    return json(
      {
        client_id: seal({ t: 'client', r: uris }),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(typeof body.client_name === 'string'
          ? { client_name: body.client_name }
          : {})
      },
      201
    );
  }

  function redirectWithError(
    flow: { r: string; s?: string },
    error: string,
    description: string
  ): Response {
    const url = new URL(flow.r);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (flow.s !== undefined) url.searchParams.set('state', flow.s);
    return redirect(url.toString());
  }

  // Until the client and redirect uri check out, errors render here: redirecting
  // to an unverified uri would make this an open redirector.
  function authorize(url: URL): Response {
    const params = url.searchParams;
    const clientId = params.get('client_id');
    const redirectUri = params.get('redirect_uri');
    const client = open(clientId, 'client');
    if (!clientId || !client) {
      return htmlResponse(
        errorPage(
          'Unknown client',
          'This client is not registered here. Remove the connector and add it again.'
        ),
        400
      );
    }
    if (
      !redirectUri ||
      !client.r.some((registered) =>
        redirectUriMatches(registered, redirectUri)
      )
    ) {
      return htmlResponse(
        errorPage(
          'Invalid redirect uri',
          'The client did not register this redirect uri.'
        ),
        400
      );
    }
    const state = params.get('state') ?? undefined;
    const flow = {
      r: redirectUri,
      ...(state !== undefined ? { s: state } : {})
    };
    if (params.get('response_type') !== 'code') {
      return redirectWithError(
        flow,
        'unsupported_response_type',
        'Only the authorization code flow is supported.'
      );
    }
    const challenge = params.get('code_challenge');
    if (!challenge || params.get('code_challenge_method') !== 'S256') {
      return redirectWithError(
        flow,
        'invalid_request',
        'PKCE with code_challenge_method=S256 is required.'
      );
    }

    const sealed = seal(
      { t: 'state', c: clientId, p: challenge, ...flow },
      STATE_TTL_MS
    );
    // The cookie covers an upstream that does not echo `state` back.
    return redirect(
      options.upstream.authorizeUrl({
        redirectUri: callbackUri,
        state: sealed
      }),
      `${COOKIE}=${sealed}; Path=${basePath}/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(STATE_TTL_MS / 1000)}`
    );
  }

  function finish(
    flow: Flow,
    tokens: UpstreamTokens,
    settings: Record<string, string>
  ): Response {
    const code = seal(
      {
        t: 'code',
        c: flow.c,
        r: flow.r,
        p: flow.p,
        u: tokens,
        a: settings,
        ...(flow.s !== undefined ? { s: flow.s } : {})
      },
      CODE_TTL_MS
    );
    const target = new URL(flow.r);
    target.searchParams.set('code', code);
    if (flow.s !== undefined) target.searchParams.set('state', flow.s);
    return redirect(
      target.toString(),
      `${COOKIE}=; Path=${basePath}/oauth; HttpOnly; Secure; Max-Age=0`
    );
  }

  async function askSettings(
    flow: Flow,
    tokens: UpstreamTokens
  ): Promise<Response> {
    const form = await options.settings?.(tokens.accessToken);
    if (!form || form.fields.length === 0) return finish(flow, tokens, {});
    const pending = seal(
      {
        t: 'pending',
        c: flow.c,
        r: flow.r,
        p: flow.p,
        u: tokens,
        ...(flow.s !== undefined ? { s: flow.s } : {})
      },
      STATE_TTL_MS
    );
    // Browsers apply form-action to the redirect after the POST, so the client's origin must be allowed.
    return htmlResponse(
      settingsPage(form, `${origin}${paths.settings}`, pending),
      200,
      [new URL(flow.r).origin]
    );
  }

  async function callback(request: Request, url: URL): Promise<Response> {
    const failure = url.searchParams.get('error');
    if (failure) {
      return htmlResponse(
        errorPage(
          `${options.name} refused the sign-in`,
          url.searchParams.get('error_description') ?? failure
        ),
        400
      );
    }
    const state =
      open(url.searchParams.get('state'), 'state') ??
      open(readCookie(request, COOKIE), 'state');
    const code = url.searchParams.get('code');
    if (!state || !code) {
      return htmlResponse(
        errorPage(
          'Sign-in expired',
          'This sign-in is unknown or took too long. Start again from your client.'
        ),
        400
      );
    }
    try {
      const tokens = await options.upstream.exchangeCode({
        code,
        redirectUri: callbackUri
      });
      return await askSettings(state, tokens);
    } catch (error) {
      return htmlResponse(
        errorPage(
          `Could not finish signing in to ${options.name}`,
          error instanceof Error ? error.message : String(error)
        ),
        502
      );
    }
  }

  async function settings(request: Request): Promise<Response> {
    const body = await readForm(request);
    const pending = open(body.get('pending'), 'pending');
    if (!pending) {
      return htmlResponse(
        errorPage(
          'Sign-in expired',
          'This took too long. Start again from your client.'
        ),
        400
      );
    }
    let form: SettingsForm | undefined;
    try {
      // Asked again rather than trusted from the page, so only offered values pass.
      form = await options.settings?.(pending.u.accessToken);
    } catch (error) {
      return htmlResponse(
        errorPage(
          `Could not reach ${options.name}`,
          error instanceof Error ? error.message : String(error)
        ),
        502
      );
    }
    const answers = form ? readSettings(form, body) : {};
    if (typeof answers === 'string') {
      return htmlResponse(errorPage('Invalid choice', answers), 400);
    }
    return finish(pending, pending.u, answers);
  }

  function issue(
    clientId: string,
    tokens: UpstreamTokens,
    settings: Record<string, string>
  ): Response {
    // Expire before the upstream token does, so the client refreshes both in time.
    const ttl =
      tokens.expiresAt === undefined
        ? ACCESS_TTL_MS
        : Math.max(
            60_000,
            Math.min(
              ACCESS_TTL_MS,
              tokens.expiresAt - Date.now() - UPSTREAM_LEEWAY_MS
            )
          );
    return json({
      access_token: seal(
        { t: 'access', u: tokens.accessToken, a: settings },
        ttl
      ),
      token_type: 'Bearer',
      expires_in: Math.floor(ttl / 1000),
      refresh_token: seal(
        { t: 'refresh', c: clientId, u: tokens, a: settings },
        REFRESH_TTL_MS
      )
    });
  }

  function exchangeCode(body: URLSearchParams): Response {
    const raw = body.get('code');
    const verifier = body.get('code_verifier');
    const code = open(raw, 'code');
    if (!raw || !code || !verifier) {
      return oauthError(
        'invalid_grant',
        'The code is unknown or expired, or code_verifier is missing.'
      );
    }
    const clientId = body.get('client_id');
    if (clientId !== null && clientId !== code.c) {
      return oauthError(
        'invalid_grant',
        'This code belongs to another client.'
      );
    }
    const redirectUri = body.get('redirect_uri');
    if (redirectUri !== null && redirectUri !== code.r) {
      return oauthError('invalid_grant', 'redirect_uri does not match.');
    }
    if (!verifyPkce(verifier, code.p)) {
      return oauthError('invalid_grant', 'The PKCE verifier does not match.');
    }
    if (!remember(raw)) {
      return oauthError('invalid_grant', 'This code was already used.');
    }
    return issue(code.c, code.u, code.a);
  }

  async function exchangeRefresh(body: URLSearchParams): Promise<Response> {
    const refresh = open(body.get('refresh_token'), 'refresh');
    if (!refresh) {
      return oauthError(
        'invalid_grant',
        'The refresh token is unknown or expired.'
      );
    }
    const clientId = body.get('client_id');
    if (clientId !== null && clientId !== refresh.c) {
      return oauthError(
        'invalid_grant',
        'This refresh token belongs to another client.'
      );
    }
    let tokens = refresh.u;
    if (
      tokens.expiresAt !== undefined &&
      tokens.expiresAt - UPSTREAM_LEEWAY_MS <= Date.now()
    ) {
      if (!tokens.refreshToken || !options.upstream.refresh) {
        return oauthError(
          'invalid_grant',
          `The ${options.name} sign-in expired. Sign in again.`
        );
      }
      try {
        const renewed = await options.upstream.refresh(tokens.refreshToken);
        tokens = {
          ...renewed,
          refreshToken: renewed.refreshToken ?? tokens.refreshToken
        };
      } catch (error) {
        return oauthError(
          'invalid_grant',
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    return issue(refresh.c, tokens, refresh.a);
  }

  async function token(request: Request): Promise<Response> {
    const body = await readForm(request);
    const grantType = body.get('grant_type');
    if (grantType === 'authorization_code') return exchangeCode(body);
    if (grantType === 'refresh_token') return exchangeRefresh(body);
    return oauthError(
      'unsupported_grant_type',
      'Use authorization_code or refresh_token.'
    );
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers':
            'authorization, content-type, mcp-protocol-version',
          'access-control-max-age': '86400'
        }
      });
    }
    if (method === 'GET' && isResourcePath(path)) {
      return json({
        resource: issuer,
        authorization_servers: [issuer],
        bearer_methods_supported: ['header'],
        resource_name: options.name
      });
    }
    if (method === 'GET' && serverPaths.has(path)) {
      return json(authorizationServerMetadata());
    }
    if (method === 'POST' && path === paths.register) return register(request);
    if (method === 'GET' && path === paths.authorize) return authorize(url);
    if (method === 'GET' && path === paths.callback) {
      return callback(request, url);
    }
    if (method === 'POST' && path === paths.settings) return settings(request);
    if (method === 'POST' && path === paths.token) return token(request);
    return json({ error: 'Method not allowed' }, 405);
  }

  return {
    owns,
    handle,
    authenticate(token) {
      const access = open(token, 'access');
      return access ? { accessToken: access.u, settings: access.a } : undefined;
    },
    challenge(error) {
      const parts = [`resource_metadata="${resourceMetadataUrl}"`];
      if (error) parts.unshift(`error="${error}"`);
      return `Bearer ${parts.join(', ')}`;
    }
  };
}
