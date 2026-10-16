import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

import * as client from 'openid-client';

import { AuthError, createAuth, describeAuthError } from './auth.js';
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

// client.discovery() failures must be wrapped as AuthError('discovery_failed'),
// never leaked as the raw underlying error, and the cache must reset so a later
// call can retry successfully. Each test below uses its own fresh createAuth()
// instance (instead of the shared `auth` above) because the shared instance's
// discovery promise is already resolved and cached by earlier tests, so
// mockRejectedValueOnce would have no effect on it.
describe('createAuth - discovery failure handling', () => {
  function freshAuth() {
    return createAuth(() => ({
      issuer: 'https://id.example',
      clientId: 'id',
      clientSecret: 'secret',
      appUrl: 'https://app.example',
      sessionSecret: 'x'.repeat(32),
      cookiePrefix: 'cellar'
    }));
  }

  it('wraps a discovery failure from startLogin as AuthError with code discovery_failed, not the raw error', async () => {
    const instance = freshAuth();
    const underlying = new Error('network down');
    vi.mocked(client.discovery).mockRejectedValueOnce(underlying);

    const promise = instance.startLogin('/x');
    await expect(promise).rejects.toBeInstanceOf(AuthError);
    await expect(promise).rejects.toMatchObject({
      code: 'discovery_failed',
      cause: underlying
    });
  });

  it('wraps a discovery failure from finishLogin as AuthError with code discovery_failed, using a valid flow cookie so flow_expired is not triggered instead', async () => {
    const instance = freshAuth();
    vi.mocked(client.discovery).mockRejectedValueOnce(
      new Error('network down')
    );

    const validFlowCookie = JSON.stringify({
      state: 's',
      nonce: 'n',
      verifier: 'v',
      returnTo: '/'
    });

    const promise = instance.finishLogin(
      'https://app.example/api/auth/callback?code=x',
      validFlowCookie
    );
    await expect(promise).rejects.toBeInstanceOf(AuthError);
    await expect(promise).rejects.toMatchObject({ code: 'discovery_failed' });
  });

  it('retries discovery and succeeds on a later call after a prior discovery failure (cache is reset, not stuck on the failed attempt)', async () => {
    const instance = freshAuth();
    const discoveryMock = vi.mocked(client.discovery);
    const callsBefore = discoveryMock.mock.calls.length;
    discoveryMock.mockRejectedValueOnce(new Error('network down'));

    await expect(instance.startLogin('/x')).rejects.toBeInstanceOf(AuthError);

    // A later call on the very same instance must attempt discovery again
    // (the mock's default implementation resolves) rather than replaying the
    // same failed/cached attempt forever.
    const result = await instance.startLogin('/x');
    expect(typeof result.url).toBe('string');
    expect(discoveryMock.mock.calls.length).toBe(callsBefore + 2);
  });

  // PKG-13 changes configuration()'s catch handler so it only clears
  // `discovered` when `discovered === attempt` still holds, i.e. only when no
  // newer attempt has since replaced the one that just failed (instead of
  // unconditionally nulling it out). A literal overlapping race through the
  // public API (startLogin/finishLogin) cannot be constructed today, though:
  // configuration() is a plain synchronous function that assigns `discovered`
  // before it ever returns a promise, and both startLogin() and finishLogin()
  // call it before their first `await` (finishLogin() does a synchronous
  // parseFlow() check first, but nothing in between can yield control).
  // Calling either of them twice back-to-back therefore can never produce two
  // *different* `attempt` promises in flight for the same instance — the
  // second call's synchronous prelude always observes the first call's
  // already-assigned `discovered` and reuses that exact same promise. There
  // is no `await` anywhere between the `!discovered` check and the
  // `discovered = ...` assignment, so nothing can interleave there. This test
  // therefore does not attempt a same-instance race (it would be a no-op race
  // that can't fail either way); instead it verifies, through the public API,
  // the one property the identity check actually protects in practice: that
  // the `discovered` cache a failed attempt clears is scoped to its own
  // createAuth() closure and never leaks into or clobbers another instance's
  // cache. "A single failed attempt must still clear its own cache" is
  // already covered end-to-end by the test above; this test adds "...and
  // never anyone else's".
  it('keeps discovery caches independent across separate createAuth() instances, so a failure on one instance never disturbs another instance that already cached (or is using) its own configuration', async () => {
    const discoveryMock = vi.mocked(client.discovery);
    const instanceA = freshAuth();
    const instanceB = freshAuth();

    // instanceB succeeds first and caches its own configuration.
    await instanceB.startLogin('/x');
    const callsAfterBSucceeds = discoveryMock.mock.calls.length;

    // instanceA's discovery now fails.
    discoveryMock.mockRejectedValueOnce(new Error('network down'));
    await expect(instanceA.startLogin('/x')).rejects.toBeInstanceOf(AuthError);

    // instanceB must be completely unaffected: its own cached configuration
    // is still used, so this call does not trigger a new discovery request.
    await instanceB.startLogin('/x');
    expect(discoveryMock.mock.calls.length).toBe(callsAfterBSucceeds + 1);

    // instanceA, meanwhile, must still be able to retry and succeed, proving
    // its own cache (and only its own) was the one cleared by its own
    // failed attempt.
    const resultA = await instanceA.startLogin('/x');
    expect(typeof resultA.url).toBe('string');
    expect(discoveryMock.mock.calls.length).toBe(callsAfterBSucceeds + 2);
  });
});

// The insecure-http gate must be default-deny: a plain-http issuer is only
// ever allowed when the caller explicitly opts in via `allowInsecureHttp`,
// AND `NODE_ENV` is not 'production'. In particular an unset NODE_ENV (very
// common outside Next.js, e.g. scripts/workers) must never, by itself, open
// the gate. Each test below creates its own fresh createAuth() instance for
// the same reason as the discovery-failure-handling tests above: `discovered`
// is cached per closure, so a shared instance would only ever call
// client.discovery() once and later tests would just read the stale args.
describe('createAuth - insecure http gate', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  function freshAuth(overrides: {
    issuer: string;
    allowInsecureHttp?: boolean;
  }) {
    return createAuth(() => ({
      issuer: overrides.issuer,
      clientId: 'id',
      clientSecret: 'secret',
      appUrl: 'https://app.example',
      sessionSecret: 'x'.repeat(32),
      cookiePrefix: 'cellar',
      // Only set the field when the test cares about it, so we also cover
      // the "field left unset entirely" shape, not just "set to false".
      ...(overrides.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: overrides.allowInsecureHttp })
    }));
  }

  // The 5th argument to client.discovery() is `{ execute: [...] }` only when
  // the gate is open; otherwise it must be `undefined`. Scoped to "the call
  // this test triggered" (via the before-count) rather than just
  // `mock.calls.at(-1)`, so a future regression where startLogin() stops
  // reaching client.discovery() at all can't make a denial assertion pass
  // vacuously on a previous test's leftover call args.
  function discoveryExecuteArgOfNextCall(callsBefore: number): () => unknown {
    return () => {
      const discoveryMock = vi.mocked(client.discovery);
      expect(discoveryMock.mock.calls.length).toBe(callsBefore + 1);
      return discoveryMock.mock.calls[callsBefore]?.[4];
    };
  }

  it('rejects a plain-http issuer when allowInsecureHttp is unset and NODE_ENV is undefined', async () => {
    delete process.env.NODE_ENV;
    const instance = freshAuth({ issuer: 'http://id.local' });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toBeUndefined();
  });

  it('rejects a plain-http issuer when allowInsecureHttp is unset and NODE_ENV is "test"', async () => {
    process.env.NODE_ENV = 'test';
    const instance = freshAuth({ issuer: 'http://id.local' });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toBeUndefined();
  });

  it('rejects a plain-http issuer when allowInsecureHttp is explicitly false', async () => {
    delete process.env.NODE_ENV;
    const instance = freshAuth({
      issuer: 'http://id.local',
      allowInsecureHttp: false
    });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toBeUndefined();
  });

  it('allows a plain-http issuer when allowInsecureHttp is true and NODE_ENV is not production (local dev)', async () => {
    delete process.env.NODE_ENV;
    const instance = freshAuth({
      issuer: 'http://id.local',
      allowInsecureHttp: true
    });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toEqual({
      execute: [client.allowInsecureRequests]
    });
  });

  it('rejects a plain-http issuer when allowInsecureHttp is true but NODE_ENV is "production" (prod override wins even if the flag is left on)', async () => {
    process.env.NODE_ENV = 'production';
    const instance = freshAuth({
      issuer: 'http://id.local',
      allowInsecureHttp: true
    });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toBeUndefined();
  });

  it('never opens the insecure gate for an https issuer, even when allowInsecureHttp is true and NODE_ENV is undefined', async () => {
    delete process.env.NODE_ENV;
    const instance = freshAuth({
      issuer: 'https://id.example',
      allowInsecureHttp: true
    });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toBeUndefined();
  });
});

describe('describeAuthError', () => {
  it('returns name, code and message for an AuthError, and nothing else', () => {
    const error = new AuthError('no_identity');
    const info = describeAuthError(error);

    expect(info).not.toBeNull();
    expect(info).toEqual({
      name: 'AuthError',
      code: 'no_identity',
      message: 'no_identity'
    });
    // Explicitly guard against leaking the internal `cause` or the stack
    // trace, which may contain details not meant for API consumers.
    expect(Object.hasOwn(info as object, 'cause')).toBe(false);
    expect(Object.hasOwn(info as object, 'stack')).toBe(false);
    expect(Object.keys(info as object).sort()).toEqual([
      'code',
      'message',
      'name'
    ]);
  });

  it.each([
    'flow_expired',
    'discovery_failed',
    'exchange_failed',
    'no_identity',
    'profile_unreachable',
    'no_email'
  ] as const)('reports message equal to the code for %s', (code) => {
    const info = describeAuthError(new AuthError(code));
    expect(info?.message).toBe(code);
    expect(info?.code).toBe(code);
  });

  it('returns null for anything that is not an AuthError, without throwing', () => {
    expect(describeAuthError(new Error('plain'))).toBeNull();
    expect(describeAuthError('just a string')).toBeNull();
    expect(describeAuthError(undefined)).toBeNull();
    expect(describeAuthError(null)).toBeNull();
    expect(describeAuthError(42)).toBeNull();
    expect(
      describeAuthError({ code: 'no_email', message: 'no_email' })
    ).toBeNull();
    expect(() => describeAuthError(undefined)).not.toThrow();
  });

  it('never exposes values carried in `cause`, even when they look like secrets', () => {
    const secretToken = 'super-secret-token-material-xyz';
    const error = new AuthError('exchange_failed', {
      cause: {
        response: { body: secretToken },
        header: `Bearer ${secretToken}`
      }
    });

    const info = describeAuthError(error);

    expect(info).not.toBeNull();
    // The secret must not surface anywhere in the serialized result...
    expect(JSON.stringify(info)).not.toContain(secretToken);
    // ...and the cause's own properties must not have been spread onto the
    // result object either (only the three documented fields may exist).
    expect(Object.keys(info as object).sort()).toEqual([
      'code',
      'message',
      'name'
    ]);
    expect(Object.hasOwn(info as object, 'response')).toBe(false);
    expect(Object.hasOwn(info as object, 'header')).toBe(false);
  });

  it('matches the `profile_unreachable` throw site and its cause as well', () => {
    const secretToken = 'another-secret-value-123';
    const error = new AuthError('profile_unreachable', {
      cause: new Error(secretToken)
    });

    const info = describeAuthError(error);

    expect(info).toEqual({
      name: 'AuthError',
      code: 'profile_unreachable',
      message: 'profile_unreachable'
    });
    expect(JSON.stringify(info)).not.toContain(secretToken);
  });
});
