import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>();
  return {
    ...actual,
    discovery: vi.fn(
      async () =>
        new actual.Configuration(
          {
            issuer: 'https://id.example',
            authorization_endpoint: 'https://id.example/oauth/v2/authorize'
          },
          'id',
          'secret'
        )
    )
  };
});

import { AuthError, createAuth } from './auth.js';
import { safeReturnTo } from './return-to.js';
import { signSession, verifySession } from './session.js';

const keys = {
  secret: 'x'.repeat(32),
  audience: 'https://app.example',
  maxAgeSeconds: 60
};

describe('safeReturnTo', () => {
  it.each([
    ['/instances/a?x=1#y', '/instances/a?x=1#y'],
    ['/', '/'],
    [null, '/'],
    ['', '/'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['relative', '/']
  ])('%s -> %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});

describe('session', () => {
  it('round-trips', async () => {
    const token = await signSession(
      { sub: 'u1', email: 'a@b.c', name: 'A' },
      keys
    );
    await expect(verifySession(token, keys)).resolves.toMatchObject({
      sub: 'u1',
      email: 'a@b.c',
      name: 'A'
    });
  });

  it('carries authTime, defaulting to the signing time', async () => {
    const now = Math.floor(Date.now() / 1000);
    const given = await signSession(
      { sub: 'u1', email: 'a@b.c', name: null, authTime: now - 600 },
      keys,
      now
    );
    await expect(verifySession(given, keys)).resolves.toMatchObject({
      authTime: now - 600
    });

    const fresh = await signSession(
      { sub: 'u1', email: 'a@b.c', name: null },
      keys,
      now
    );
    await expect(verifySession(fresh, keys)).resolves.toMatchObject({
      authTime: now
    });
  });

  it('reads a 1.0.0 session without auth_time as authenticated at iat', async () => {
    const now = Math.floor(Date.now() / 1000);
    const legacy = await new SignJWT({ email: 'a@b.c', name: null })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('u1')
      .setIssuedAt(now - 30)
      .setExpirationTime(now + 30)
      .setIssuer(keys.audience)
      .setAudience(keys.audience)
      .sign(new TextEncoder().encode(keys.secret));
    await expect(verifySession(legacy, keys)).resolves.toMatchObject({
      authTime: now - 30
    });
  });

  it('rejects another secret, audience or an expired token', async () => {
    const token = await signSession(
      { sub: 'u1', email: 'a@b.c', name: null },
      keys
    );
    await expect(
      verifySession(token, { ...keys, secret: 'y'.repeat(32) })
    ).resolves.toBeNull();
    await expect(
      verifySession(token, { ...keys, audience: 'https://other.example' })
    ).resolves.toBeNull();

    const old = await signSession(
      { sub: 'u1', email: 'a@b.c', name: null },
      keys,
      Math.floor(Date.now() / 1000) - 3600
    );
    await expect(verifySession(old, keys)).resolves.toBeNull();
  });

  it('rejects garbage and empty input', async () => {
    await expect(verifySession('not.a.jwt', keys)).resolves.toBeNull();
    await expect(verifySession(undefined, keys)).resolves.toBeNull();
  });

  it('refuses a short secret', async () => {
    await expect(
      signSession(
        { sub: 'u', email: 'e', name: null },
        { ...keys, secret: 'short' }
      )
    ).rejects.toThrow(RangeError);
  });
});

describe('createAuth', () => {
  const auth = createAuth(() => ({
    issuer: 'https://id.example',
    clientId: 'id',
    clientSecret: 'secret',
    appUrl: 'https://app.example',
    sessionSecret: 'x'.repeat(32),
    cookiePrefix: 'cellar'
  }));

  it('reads no config until used', () => {
    expect(() =>
      createAuth(() => {
        throw new Error('env missing');
      })
    ).not.toThrow();
  });

  it('names cookies with the __Host- prefix', () => {
    expect(auth.sessionCookieName()).toBe('__Host-cellar_session');
    expect(auth.flowCookieName()).toBe('__Host-cellar_oidc');
  });

  it('clears both cookies on logout', () => {
    const cleared = auth.logoutCookies();
    expect(cleared.map((c) => [c.name, c.value, c.options.maxAge])).toEqual([
      ['__Host-cellar_session', '', 0],
      ['__Host-cellar_oidc', '', 0]
    ]);
  });

  it('fails a callback without flow cookie before any network call', async () => {
    await expect(
      auth.finishLogin(
        'https://app.example/api/auth/callback?code=x',
        undefined
      )
    ).rejects.toMatchObject({ code: 'flow_expired' });
    await expect(
      auth.finishLogin('https://app.example/api/auth/callback', '{"state":1}')
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('reads a session it signed', async () => {
    const token = await signSession(
      { sub: 'u1', email: 'a@b.c', name: null },
      {
        secret: 'x'.repeat(32),
        audience: 'https://app.example',
        maxAgeSeconds: 60
      }
    );
    await expect(auth.readSession(token)).resolves.toMatchObject({ sub: 'u1' });
  });

  it('asks for credentials again only when told to', async () => {
    const plain = new URL((await auth.startLogin('/x')).url);
    expect(plain.searchParams.get('prompt')).toBeNull();

    const again = new URL(
      (await auth.startLogin('/x', { reauthenticate: true })).url
    );
    expect(again.searchParams.get('prompt')).toBe('login');
    expect(again.searchParams.get('code_challenge_method')).toBe('S256');
  });
});
