import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGitHubApp, GitHubAppError } from './index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

interface Call {
  url: string;
  method: string;
  body: unknown;
  auth: string;
}

function fakeGitHub(
  respond: (call: Call) => { status?: number; body: unknown }
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: headers.get('authorization') ?? ''
    };
    calls.push(call);
    const { status = 200, body } = respond(call);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    );
  };
  return { fetch: fetchFn, calls };
}

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

function github(): ReturnType<typeof fakeGitHub> {
  let n = 0;
  return fakeGitHub((call) => {
    if (call.url.endsWith('/orgs/ultimatelemon/installation')) {
      return { body: { id: 42 } };
    }
    if (call.url.endsWith('/app/installations/42/access_tokens')) {
      n += 1;
      return {
        status: 201,
        body: {
          token: `ghs_${String(n)}`,
          expires_at: new Date(NOW + 60 * 60_000).toISOString()
        }
      };
    }
    return { status: 404, body: { message: 'Not Found' } };
  });
}

function decode(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

describe('jwt', () => {
  it('is an RS256 JWT issued by the client ID, backdated against clock skew', () => {
    const app = createGitHubApp({
      clientId: 'Iv23test',
      privateKey,
      now: () => NOW
    });
    const [header, payload, signature] = app.jwt().split('.');
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(payload);
    expect(claims['iss']).toBe('Iv23test');
    expect(claims['iat']).toBe(NOW / 1000 - 60);
    // GitHub refuses a JWT that lives longer than ten minutes.
    expect(Number(claims['exp']) - NOW / 1000).toBeLessThanOrEqual(600);
    const valid = createVerify('RSA-SHA256')
      .update(`${header ?? ''}.${payload ?? ''}`)
      .verify(publicKey, signature ?? '', 'base64url');
    expect(valid).toBe(true);
  });
});

describe('installationToken', () => {
  it('narrows the token to the requested repositories and permissions', async () => {
    const gh = github();
    const app = createGitHubApp({
      clientId: 'Iv23test',
      privateKey,
      fetch: gh.fetch,
      now: () => NOW
    });
    const token = await app.installationToken({
      owner: 'ultimatelemon',
      repositories: ['nova', 'packages'],
      permissions: { contents: 'write' }
    });
    expect(token.token).toBe('ghs_1');
    const mint = gh.calls.at(-1);
    expect(mint?.method).toBe('POST');
    expect(mint?.body).toEqual({
      repositories: ['nova', 'packages'],
      permissions: { contents: 'write' }
    });
    expect(mint?.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('reuses a token until five minutes before it expires', async () => {
    const gh = github();
    let now = NOW;
    const app = createGitHubApp({
      clientId: 'Iv23test',
      privateKey,
      fetch: gh.fetch,
      now: () => now
    });
    const request = { owner: 'ultimatelemon', repositories: ['nova'] };
    expect((await app.installationToken(request)).token).toBe('ghs_1');
    now = NOW + 50 * 60_000;
    expect((await app.installationToken(request)).token).toBe('ghs_1');
    now = NOW + 56 * 60_000;
    expect((await app.installationToken(request)).token).toBe('ghs_2');
    // The installation is looked up once.
    expect(
      gh.calls.filter((c) => c.url.endsWith('/installation'))
    ).toHaveLength(1);
  });

  it('keeps tokens for different repositories apart, whatever the order', async () => {
    const gh = github();
    const app = createGitHubApp({
      clientId: 'Iv23test',
      privateKey,
      fetch: gh.fetch,
      now: () => NOW
    });
    const a = await app.installationToken({
      owner: 'ultimatelemon',
      repositories: ['nova', 'packages']
    });
    const same = await app.installationToken({
      owner: 'UltimateLemon',
      repositories: ['packages', 'nova']
    });
    const other = await app.installationToken({
      owner: 'ultimatelemon',
      repositories: ['nova']
    });
    expect(same.token).toBe(a.token);
    expect(other.token).not.toBe(a.token);
  });

  it('refuses an empty repository list, which GitHub reads as all of them', async () => {
    const app = createGitHubApp({
      clientId: 'Iv23test',
      privateKey,
      fetch: github().fetch
    });
    await expect(
      app.installationToken({ owner: 'ultimatelemon', repositories: [] })
    ).rejects.toThrow(/empty repository list/);
  });

  it("falls back to a user's installation and reports GitHub's message", async () => {
    const gh = fakeGitHub((call) =>
      call.url.endsWith('/users/someone/installation')
        ? { status: 404, body: { message: 'Not installed' } }
        : { status: 404, body: { message: 'Not Found' } }
    );
    const app = createGitHubApp({
      clientId: 'Iv23test',
      privateKey,
      fetch: gh.fetch
    });
    const error: unknown = await app
      .installationToken({ owner: 'someone' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubAppError);
    expect((error as GitHubAppError).status).toBe(404);
    expect((error as GitHubAppError).message).toMatch(/Not installed/);
    expect(gh.calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/orgs/someone/installation',
      '/users/someone/installation'
    ]);
  });

  it('does not cache a failed mint', async () => {
    let fail = true;
    const gh = fakeGitHub((call) => {
      if (call.url.endsWith('/installation')) return { body: { id: 42 } };
      if (fail) return { status: 502, body: { message: 'Bad Gateway' } };
      return {
        status: 201,
        body: {
          token: 'ghs_ok',
          expires_at: new Date(NOW + 60 * 60_000).toISOString()
        }
      };
    });
    const app = createGitHubApp({
      clientId: 'Iv23test',
      privateKey,
      fetch: gh.fetch,
      now: () => NOW
    });
    const request = { owner: 'ultimatelemon' };
    await expect(app.installationToken(request)).rejects.toThrow(/502/);
    fail = false;
    expect((await app.installationToken(request)).token).toBe('ghs_ok');
  });
});
