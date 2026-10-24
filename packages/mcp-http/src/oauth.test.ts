import { createHash, randomBytes } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startMcpHttpServer,
  type McpHttpServer,
  type OAuthUpstream,
  type RequestContext,
  type UpstreamTokens
} from './index.js';

process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');

const PUBLIC = 'https://mcp.example.test';
const REDIRECT = 'https://client.example.test/callback';

let upstreamTokens: UpstreamTokens = { accessToken: 'upstream-1' };
let refreshed = 0;
const upstream: OAuthUpstream = {
  authorizeUrl: ({ redirectUri, state }) =>
    `https://upstream.test/authorize?${new URLSearchParams({ redirect_uri: redirectUri, state }).toString()}`,
  exchangeCode: ({ code }) =>
    code === 'good'
      ? Promise.resolve(upstreamTokens)
      : Promise.reject(new Error('bad code')),
  refresh: () => {
    refreshed++;
    return Promise.resolve({
      accessToken: `upstream-refreshed-${String(refreshed)}`
    });
  }
};

const seen: RequestContext[] = [];
let http: McpHttpServer;
let base: string;

beforeAll(async () => {
  http = await startMcpHttpServer({
    createMcpServer: (context) => {
      seen.push(context);
      const server = new McpServer({ name: 'test', version: '1.0.0' });
      server.registerTool('who', { description: 'Who' }, () => ({
        content: [{ type: 'text', text: context.apiKey ?? '' }]
      }));
      return server;
    },
    port: 0,
    host: '127.0.0.1',
    basePath: '/svc',
    apiKey: {},
    oauth: {
      publicUrl: PUBLIC,
      name: 'Upstream',
      upstream,
      settings: () =>
        Promise.resolve({
          title: 'Settings',
          fields: [
            {
              name: 'account',
              label: 'Account',
              options: [
                { value: '1', label: 'One' },
                { value: '2', label: 'Two' }
              ]
            },
            {
              name: 'sets',
              label: 'Sets',
              multiple: true,
              options: [
                { value: 'a', label: 'A' },
                { value: 'b', label: 'B' }
              ]
            }
          ]
        })
    }
  });
  base = `http://127.0.0.1:${String(http.port)}`;
});

afterAll(() => http.close());

function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: 'manual', ...init });
}

function form(values: Record<string, string | string[]>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      body.append(key, entry);
    }
  }
  return body;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(): Promise<string> {
  const response = await call('/svc/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test' })
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** Walks the whole browser leg and returns the client's authorization code. */
async function signIn(
  clientId: string,
  challenge: string,
  answers: Record<string, string | string[]> = {
    account: '2',
    sets: ['a', 'b']
  }
): Promise<string> {
  const authorize = await call(
    `/svc/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'client-state'
    }).toString()}`
  );
  expect(authorize.status).toBe(302);
  const upstreamUrl = new URL(authorize.headers.get('location') ?? '');
  expect(upstreamUrl.searchParams.get('redirect_uri')).toBe(
    `${PUBLIC}/svc/oauth/callback`
  );
  const state = upstreamUrl.searchParams.get('state') ?? '';

  const callback = await call(
    `/svc/oauth/callback?${new URLSearchParams({ code: 'good', state }).toString()}`
  );
  expect(callback.status).toBe(200);
  expect(callback.headers.get('content-security-policy')).toContain(
    `form-action 'self' ${new URL(REDIRECT).origin};`
  );
  const page = await callback.text();
  const pending = /name="pending" value="([^"]+)"/.exec(page)?.[1] ?? '';
  expect(page).toContain(`action="${PUBLIC}/svc/oauth/settings"`);

  const submitted = await call('/svc/oauth/settings', {
    method: 'POST',
    body: form({ pending, ...answers })
  });
  expect(submitted.status).toBe(302);
  const back = new URL(submitted.headers.get('location') ?? '');
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('client-state');
  return back.searchParams.get('code') ?? '';
}

async function exchange(
  clientId: string,
  code: string,
  verifier: string
): Promise<Response> {
  return call('/svc/token', {
    method: 'POST',
    body: form({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT
    })
  });
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/svc`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    })
  );
  return client;
}

describe('oauth discovery', () => {
  it('points the 401 at the protected resource metadata', async () => {
    const response = await call('/svc/mcp', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${PUBLIC}/svc/.well-known/oauth-protected-resource"`
    );
  });

  it.each([
    '/svc/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/svc',
    '/.well-known/oauth-protected-resource/svc/mcp'
  ])('serves protected resource metadata on %s', async (path) => {
    const body = (await (await call(path)).json()) as Record<string, unknown>;
    expect(body['resource']).toBe(`${PUBLIC}/svc`);
    expect(body['authorization_servers']).toEqual([`${PUBLIC}/svc`]);
  });

  it.each([
    '/.well-known/oauth-authorization-server/svc',
    '/.well-known/openid-configuration/svc',
    '/svc/.well-known/openid-configuration'
  ])('serves authorization server metadata on %s', async (path) => {
    const body = (await (await call(path)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issuer: `${PUBLIC}/svc`,
      authorization_endpoint: `${PUBLIC}/svc/authorize`,
      token_endpoint: `${PUBLIC}/svc/token`,
      registration_endpoint: `${PUBLIC}/svc/register`,
      code_challenge_methods_supported: ['S256']
    });
  });
});

describe('oauth flow', () => {
  it('signs in, carries the settings and serves MCP with the upstream token', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await signIn(clientId, challenge);

    const response = await exchange(clientId, code, verifier);
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as Tokens;
    expect(tokens.expires_in).toBe(3600);

    const client = await connect(tokens.access_token);
    const result = await client.callTool({ name: 'who', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'upstream-1' }]);
    expect(seen.at(-1)?.oauth).toEqual({
      settings: { account: '2', sets: 'a,b' }
    });
    await client.close();
  });

  it('redeems a code once', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await signIn(clientId, challenge);
    expect((await exchange(clientId, code, verifier)).status).toBe(200);
    expect((await exchange(clientId, code, verifier)).status).toBe(400);
  });

  it('rejects a wrong PKCE verifier', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const code = await signIn(clientId, challenge);
    const response = await exchange(clientId, code, pkce().verifier);
    expect(response.status).toBe(400);
  });

  it('rejects settings that were not offered', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    await expect(
      signIn(clientId, challenge, { account: '9', sets: [] })
    ).rejects.toThrow();
  });

  it('refuses an unregistered redirect uri without redirecting', async () => {
    const clientId = await registerClient();
    const response = await call(
      `/svc/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: 'https://evil.test/cb',
        response_type: 'code',
        code_challenge: 'x',
        code_challenge_method: 'S256'
      }).toString()}`
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('refreshes, renewing the upstream token when it is about to expire', async () => {
    upstreamTokens = {
      accessToken: 'upstream-short',
      refreshToken: 'upstream-refresh',
      expiresAt: Date.now() + 60_000
    };
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await signIn(clientId, challenge);
    const first = (await (
      await exchange(clientId, code, verifier)
    ).json()) as Tokens;
    expect(first.expires_in).toBe(60);

    const response = await call('/svc/token', {
      method: 'POST',
      body: form({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: clientId
      })
    });
    expect(response.status).toBe(200);
    const second = (await response.json()) as Tokens;
    expect(refreshed).toBe(1);

    const client = await connect(second.access_token);
    const result = await client.callTool({ name: 'who', arguments: {} });
    expect(result.content).toEqual([
      { type: 'text', text: 'upstream-refreshed-1' }
    ]);
    await client.close();
    upstreamTokens = { accessToken: 'upstream-1' };
  });

  it('answers a forged or expired sealed token with invalid_token', async () => {
    const response = await call('/svc/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer v1.AAAA.BBBB.CCCC' }
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      'error="invalid_token"'
    );
  });

  it('still accepts a plain API key next to OAuth', async () => {
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/svc`), {
        requestInit: { headers: { 'x-api-key': 'personal' } }
      })
    );
    const result = await client.callTool({ name: 'who', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'personal' }]);
    expect(seen.at(-1)?.oauth).toBeUndefined();
    await client.close();
  });
});
