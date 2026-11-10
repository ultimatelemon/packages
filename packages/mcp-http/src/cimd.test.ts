import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createOAuthHandler,
  oidcUpstream,
  type OAuthHandler
} from './oauth-entry.js';

process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');

const PUBLIC = 'https://app.example.test';
const BASE = '/api/mcp';
const ISSUER = 'https://id.example.test';
const CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CODE_CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';

const documents: Record<string, unknown> = {
  [CLIENT_ID]: {
    client_id: CLIENT_ID,
    client_name: 'Claude',
    redirect_uris: [REDIRECT],
    grant_types: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer'
    ],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  },
  [CODE_CLIENT_ID]: {
    client_id: CODE_CLIENT_ID,
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  }
};

function idToken(claims: Record<string, unknown>): string {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

let claims: Record<string, unknown>;
let refreshClaims: Record<string, unknown> | undefined;
let lastTokenRequest: URLSearchParams | undefined;
let expectedChallenge: string | undefined;
const fetched: { url: string; init: RequestInit | undefined }[] = [];

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const fakeFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  fetched.push({ url, init });
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return Promise.resolve(
      respond({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/v2/authorize`,
        token_endpoint: `${ISSUER}/oauth/v2/token`
      })
    );
  }
  if (url === `${ISSUER}/oauth/v2/token`) {
    const body = new URLSearchParams(init?.body as URLSearchParams);
    lastTokenRequest = body;
    if (body.get('grant_type') === 'refresh_token') {
      return Promise.resolve(
        respond({
          access_token: 'zitadel-access-2',
          expires_in: 3600,
          ...(refreshClaims ? { id_token: idToken(refreshClaims) } : {})
        })
      );
    }
    const verifier = body.get('code_verifier') ?? '';
    if (
      createHash('sha256').update(verifier).digest('base64url') !==
      expectedChallenge
    ) {
      return Promise.resolve(respond({ error: 'invalid_grant' }, 400));
    }
    return Promise.resolve(
      respond({
        access_token: 'zitadel-access',
        refresh_token: 'zitadel-refresh',
        // Short, so a refresh of ours also renews the upstream token.
        expires_in: 120,
        id_token: idToken(claims)
      })
    );
  }
  const doc = documents[url];
  if (doc !== undefined) return Promise.resolve(respond(doc));
  return Promise.resolve(new Response('not found', { status: 404 }));
};

function makeHandler(
  overrides: Partial<Parameters<typeof createOAuthHandler>[0]> = {}
): OAuthHandler {
  return createOAuthHandler(
    {
      publicUrl: PUBLIC,
      name: 'Example',
      upstream: oidcUpstream({
        issuer: ISSUER,
        clientId: 'web-client',
        clientSecret: 'secret',
        scopes: ['openid', 'offline_access'],
        fetch: fakeFetch
      }),
      registration: false,
      fetch: fakeFetch,
      ...overrides
    },
    BASE
  );
}

let oauth: OAuthHandler;

beforeEach(() => {
  oauth = makeHandler();
  claims = {
    iss: ISSUER,
    aud: ['web-client', 'project-id'],
    azp: 'web-client',
    sub: 'user-123',
    exp: Math.floor(Date.now() / 1000) + 3600
  };
  refreshClaims = undefined;
  lastTokenRequest = undefined;
  expectedChallenge = undefined;
  fetched.length = 0;
});

function get(path: string, params?: Record<string, string>): Promise<Response> {
  const query = params ? `?${new URLSearchParams(params).toString()}` : '';
  return oauth.handle(new Request(`${PUBLIC}${path}${query}`));
}

function post(path: string, body: Record<string, string>): Promise<Response> {
  return oauth.handle(
    new Request(`${PUBLIC}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body)
    })
  );
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeParams(
  clientId: string,
  redirectUri: string,
  challenge: string
): Record<string, string> {
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state'
  };
}

/** The browser leg: authorize, the upstream sign-in, and back to the client. */
async function signIn(
  clientId: string,
  redirectUri: string,
  challenge: string
): Promise<Response> {
  const authorize = await get(
    `${BASE}/authorize`,
    authorizeParams(clientId, redirectUri, challenge)
  );
  expect(authorize.status).toBe(302);
  const upstream = new URL(authorize.headers.get('location') ?? '');
  expect(upstream.origin + upstream.pathname).toBe(
    `${ISSUER}/oauth/v2/authorize`
  );
  expect(upstream.searchParams.get('client_id')).toBe('web-client');
  expect(upstream.searchParams.get('scope')).toBe('openid offline_access');
  expect(upstream.searchParams.get('redirect_uri')).toBe(
    `${PUBLIC}${BASE}/oauth/callback`
  );
  expect(upstream.searchParams.get('code_challenge_method')).toBe('S256');
  expectedChallenge = upstream.searchParams.get('code_challenge') ?? '';
  return get(`${BASE}/oauth/callback`, {
    code: 'upstream-code',
    state: upstream.searchParams.get('state') ?? ''
  });
}

function codeFrom(callback: Response, redirectUri: string): string {
  expect(callback.status).toBe(302);
  const back = new URL(callback.headers.get('location') ?? '');
  expect(back.origin + back.pathname).toBe(redirectUri);
  expect(back.searchParams.get('state')).toBe('client-state');
  return back.searchParams.get('code') ?? '';
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

describe('metadata', () => {
  it('advertises client id metadata documents and no registration', async () => {
    const body = (await (
      await get('/.well-known/oauth-authorization-server/api/mcp')
    ).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issuer: `${PUBLIC}${BASE}`,
      authorization_endpoint: `${PUBLIC}${BASE}/authorize`,
      token_endpoint: `${PUBLIC}${BASE}/token`,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ['none']
    });
    expect(body).not.toHaveProperty('registration_endpoint');
  });

  it('serves the protected resource metadata under the base path', async () => {
    expect(oauth.owns(`${BASE}/.well-known/oauth-protected-resource`)).toBe(
      true
    );
    const body = (await (
      await get(`${BASE}/.well-known/oauth-protected-resource`)
    ).json()) as Record<string, unknown>;
    expect(body['resource']).toBe(`${PUBLIC}${BASE}`);
    expect(oauth.challenge()).toBe(
      `Bearer resource_metadata="${PUBLIC}${BASE}/.well-known/oauth-protected-resource"`
    );
  });

  it('offers both when registration stays on', async () => {
    oauth = makeHandler({ registration: true });
    const body = (await (
      await get(`${BASE}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(body['registration_endpoint']).toBe(`${PUBLIC}${BASE}/register`);
    expect(body['client_id_metadata_document_supported']).toBe(true);
  });

  it('can turn client id metadata documents off', async () => {
    oauth = makeHandler({ registration: true, clientIdMetadata: false });
    const body = (await (
      await get(`${BASE}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('client_id_metadata_document_supported');
  });
});

describe('client id metadata documents', () => {
  it('signs in Claude and issues tokens that carry the subject', async () => {
    const { verifier, challenge } = pkce();
    const code = codeFrom(
      await signIn(CLIENT_ID, REDIRECT, challenge),
      REDIRECT
    );
    expect(lastTokenRequest?.get('client_secret')).toBe('secret');

    const response = await post(`${BASE}/token`, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT
    });
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as Tokens;
    expect(oauth.authenticate(tokens.access_token)).toEqual({
      accessToken: 'zitadel-access',
      settings: {},
      subject: 'user-123'
    });
  });

  it('fetches the document without following redirects, and caches it', async () => {
    const { challenge } = pkce();
    await signIn(CLIENT_ID, REDIRECT, challenge);
    await signIn(CLIENT_ID, REDIRECT, challenge);
    const documentFetches = fetched.filter((entry) => entry.url === CLIENT_ID);
    expect(documentFetches).toHaveLength(1);
    expect(documentFetches[0]?.init?.redirect).toBe('error');
  });

  it('accepts Claude Code on any loopback port', async () => {
    const { challenge } = pkce();
    const redirect = 'http://localhost:53682/callback';
    codeFrom(await signIn(CODE_CLIENT_ID, redirect, challenge), redirect);
  });

  it('refuses a redirect uri the document does not list, without redirecting', async () => {
    const response = await get(
      `${BASE}/authorize`,
      authorizeParams(CLIENT_ID, 'https://evil.test/cb', pkce().challenge)
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('never fetches from a host that is not trusted', async () => {
    const response = await get(
      `${BASE}/authorize`,
      authorizeParams(
        'https://evil.test/client.json',
        'https://evil.test/cb',
        pkce().challenge
      )
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('evil.test are not accepted');
    expect(fetched).toHaveLength(0);
  });

  it.each([
    'https://claude.ai/',
    'https://claude.ai/oauth/../oauth/mcp-oauth-client-metadata',
    'https://CLAUDE.ai/oauth/mcp-oauth-client-metadata',
    'https://claude.ai:443/oauth/mcp-oauth-client-metadata',
    'https://claude.ai/oauth/mcp-oauth-client-metadata#x'
  ])('rejects the non-canonical client_id %s', async (clientId) => {
    const response = await get(
      `${BASE}/authorize`,
      authorizeParams(clientId, REDIRECT, pkce().challenge)
    );
    expect(response.status).toBe(400);
    expect(fetched).toHaveLength(0);
  });

  it.each([
    ['another client_id', { client_id: 'https://claude.ai/other' }],
    ['a client secret', { token_endpoint_auth_method: 'client_secret_post' }],
    ['no code grant', { grant_types: ['client_credentials'] }],
    ['a fragment redirect', { redirect_uris: [`${REDIRECT}#x`] }]
  ])('rejects a document with %s', async (_, change) => {
    const id = 'https://claude.ai/oauth/variant';
    documents[id] = {
      ...(documents[CLIENT_ID] as object),
      client_id: id,
      ...change
    };
    const response = await get(
      `${BASE}/authorize`,
      authorizeParams(id, REDIRECT, pkce().challenge)
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('rejects a document that is too large', async () => {
    const id = 'https://claude.ai/oauth/huge';
    documents[id] = {
      ...(documents[CLIENT_ID] as object),
      client_id: id,
      padding: 'x'.repeat(20_000)
    };
    const response = await get(
      `${BASE}/authorize`,
      authorizeParams(id, REDIRECT, pkce().challenge)
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('too large');
  });

  it('binds the code to the client that asked for it', async () => {
    const { verifier, challenge } = pkce();
    const code = codeFrom(
      await signIn(CLIENT_ID, REDIRECT, challenge),
      REDIRECT
    );
    const response = await post(`${BASE}/token`, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CODE_CLIENT_ID
    });
    expect(response.status).toBe(400);
  });
});

describe('registration off', () => {
  it('has no register endpoint', async () => {
    expect(oauth.owns(`${BASE}/register`)).toBe(false);
    const response = await oauth.handle(
      new Request(`${PUBLIC}${BASE}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [REDIRECT] })
      })
    );
    expect(response.status).toBe(405);
  });

  it('refuses a client that registered while it was on', async () => {
    const open = makeHandler({ registration: true });
    const registered = (await (
      await open.handle(
        new Request(`${PUBLIC}${BASE}/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ redirect_uris: [REDIRECT] })
        })
      )
    ).json()) as { client_id: string };
    const response = await get(
      `${BASE}/authorize`,
      authorizeParams(registered.client_id, REDIRECT, pkce().challenge)
    );
    expect(response.status).toBe(400);
  });
});

describe('oidc upstream', () => {
  it.each([
    ['another issuer', { iss: 'https://other.test' }],
    ['another audience', { aud: 'someone-else', azp: undefined }],
    ['another authorized party', { azp: 'someone-else' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['no subject', { sub: '' }]
  ])('refuses an id_token with %s', async (_, change) => {
    claims = { ...claims, ...change };
    const callback = await signIn(CLIENT_ID, REDIRECT, pkce().challenge);
    expect(callback.status).toBe(502);
    expect(callback.headers.get('location')).toBeNull();
  });

  it('renews the upstream token on refresh and keeps the subject', async () => {
    const { verifier, challenge } = pkce();
    const code = codeFrom(
      await signIn(CLIENT_ID, REDIRECT, challenge),
      REDIRECT
    );
    const first = (await (
      await post(`${BASE}/token`, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID
      })
    ).json()) as Tokens;

    refreshClaims = { ...claims };
    const response = await post(`${BASE}/token`, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: CLIENT_ID
    });
    expect(response.status).toBe(200);
    expect(lastTokenRequest?.get('refresh_token')).toBe('zitadel-refresh');
    const second = (await response.json()) as Tokens;
    expect(oauth.authenticate(second.access_token)).toMatchObject({
      accessToken: 'zitadel-access-2',
      subject: 'user-123'
    });
  });

  it('refuses a refresh that comes back for another subject', async () => {
    const { verifier, challenge } = pkce();
    const code = codeFrom(
      await signIn(CLIENT_ID, REDIRECT, challenge),
      REDIRECT
    );
    const first = (await (
      await post(`${BASE}/token`, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID
      })
    ).json()) as Tokens;

    refreshClaims = { ...claims, sub: 'someone-else' };
    const response = await post(`${BASE}/token`, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: CLIENT_ID
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'invalid_grant'
    );
  });

  it('sends the secret as basic auth when asked', async () => {
    oauth = makeHandler({
      upstream: oidcUpstream({
        issuer: ISSUER,
        clientId: 'web-client',
        clientSecret: 's:cret',
        scopes: ['openid', 'offline_access'],
        tokenEndpointAuthMethod: 'client_secret_basic',
        fetch: fakeFetch
      })
    });
    claims = { ...claims, aud: 'web-client', azp: undefined };
    codeFrom(await signIn(CLIENT_ID, REDIRECT, pkce().challenge), REDIRECT);
    const tokenCall = fetched.find(
      (entry) => entry.url === `${ISSUER}/oauth/v2/token`
    );
    const headers = new Headers(tokenCall?.init?.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from('web-client:s%3Acret').toString('base64')}`
    );
    expect(lastTokenRequest?.has('client_secret')).toBe(false);
  });

  it('refuses an issuer that is not https', () => {
    expect(() =>
      oidcUpstream({
        issuer: 'http://id.example.test',
        clientId: 'a',
        clientSecret: 'b'
      })
    ).toThrow('https');
  });
});
