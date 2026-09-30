import { describe, expect, it } from 'vitest';

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
    await expect(verifySession(token, keys)).resolves.toEqual({
      sub: 'u1',
      email: 'a@b.c',
      name: 'A'
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
});
