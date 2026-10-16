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
    ),
    // No default implementation: every test below that reaches this call
    // sets its own resolved/rejected value via
    // vi.mocked(client.authorizationCodeGrant).
    authorizationCodeGrant: vi.fn()
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
});

// `finishLogin()` must not mislabel every failure between `await
// configuration()` and the actual token exchange as `exchange_failed`. Only a
// genuine failure of `client.authorizationCodeGrant(...)` itself may produce
// that code; anything thrown by the consumer-supplied config function (the
// `resolve()` callback passed to `createAuth`) while building the redirect
// URI must propagate unwrapped, since callers rely on being able to tell
// their own configuration bugs apart from a failed code exchange.
describe('createAuth - exchange_failed scope', () => {
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

  const validFlowCookie = JSON.stringify({
    state: 's',
    nonce: 'n',
    verifier: 'v',
    returnTo: '/'
  });

  it('propagates a throw from the consumer resolve() config function during finishLogin() as-is, not as AuthError exchange_failed', async () => {
    // The resolve() callback only throws once discovery has already
    // succeeded and been cached, so finishLogin()'s `await configuration()`
    // resolves from cache without calling resolve() again, and the only
    // remaining caller of resolve() is callbackUrlFor() -> callbackUrl() ->
    // settings(). That call must not get relabelled as exchange_failed.
    let shouldThrow = false;
    const thrownError = new Error('consumer config exploded');
    const instance = createAuth(() => {
      if (shouldThrow) throw thrownError;
      return {
        issuer: 'https://id.example',
        clientId: 'id',
        clientSecret: 'secret',
        appUrl: 'https://app.example',
        sessionSecret: 'x'.repeat(32),
        cookiePrefix: 'cellar'
      };
    });

    // Warm the discovery cache while resolve() still returns valid config.
    await instance.startLogin('/x');

    // Now make the consumer config function start throwing, and exercise
    // finishLogin() with a flow cookie that is valid enough to get past
    // parseFlow() and reach `await configuration()` (cached, so it
    // succeeds) and then callbackUrlFor(requestUrl).
    shouldThrow = true;
    // Cleared so the "never called" assertion below cannot pass merely
    // because an earlier test in this file happened not to reach this mock.
    vi.mocked(client.authorizationCodeGrant).mockClear();
    const promise = instance.finishLogin(
      'https://app.example/api/auth/callback?code=x',
      validFlowCookie
    );

    await expect(promise).rejects.toBe(thrownError);
    await expect(promise).rejects.not.toBeInstanceOf(AuthError);

    // The resolve() throw must happen before the token exchange is ever
    // attempted, further proving this isn't a mislabeled exchange failure.
    expect(client.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('still wraps a genuine client.authorizationCodeGrant() failure as AuthError exchange_failed with the original error as cause', async () => {
    const instance = freshAuth();
    const underlying = new Error('token endpoint rejected the code');
    vi.mocked(client.authorizationCodeGrant).mockRejectedValueOnce(underlying);

    const promise = instance.finishLogin(
      'https://app.example/api/auth/callback?code=x',
      validFlowCookie
    );

    await expect(promise).rejects.toBeInstanceOf(AuthError);
    await expect(promise).rejects.toMatchObject({
      code: 'exchange_failed',
      cause: underlying
    });
  });

  it('still reports discovery_failed, not a raw error, when discovery fails and the redirect URI would also fail to build (ordering regression: redirectUri must be computed after configuration(), not before)', async () => {
    // Both `configuration()` and the hoisted `callbackUrlFor(requestUrl)`
    // line can throw on their own (discovery() rejecting; `new URL()` on a
    // malformed requestUrl, respectively). If the redirectUri line were ever
    // moved before `await configuration()`, this malformed requestUrl would
    // throw first and discovery_failed would never surface -- this test
    // fails loudly if that reordering happens.
    const instance = freshAuth();
    const discoveryMock = vi.mocked(client.discovery);
    const callsBefore = discoveryMock.mock.calls.length;
    discoveryMock.mockRejectedValueOnce(new Error('network down'));

    const promise = instance.finishLogin('not a valid url', validFlowCookie);

    await expect(promise).rejects.toBeInstanceOf(AuthError);
    await expect(promise).rejects.toMatchObject({ code: 'discovery_failed' });

    // Proves `client.discovery()` was actually reached (and the queued
    // rejection above consumed) rather than this test passing vacuously
    // because `callbackUrlFor()` threw first and `client.discovery()` was
    // never called -- which is exactly the regression this test guards
    // against. A leaked `mockRejectedValueOnce` would otherwise silently
    // fail an unrelated, later test instead of this one.
    expect(discoveryMock.mock.calls.length).toBe(callsBefore + 1);
  });
});

// The insecure-http gate must be default-deny: a plain-http issuer is only
// ever allowed when the caller explicitly opts in via `allowInsecureHttp`,
// AND `NODE_ENV` is not 'production', AND the issuer's hostname is a
// loopback address (exactly `localhost`, `127.0.0.1`, `[::1]`, or a hostname
// ending in `.localhost`). In particular an unset NODE_ENV (very common
// outside Next.js, e.g. scripts/workers) must never, by itself, open the
// gate, and neither may a non-loopback plain-http hostname even with the
// flag on and a non-production NODE_ENV. The tests below that only exercise
// the allowInsecureHttp/NODE_ENV logic deliberately use a loopback issuer
// (`http://localhost:8080`) so the hostname check never confounds what they
// claim to test; the hostname allowlist itself is covered separately further
// down. Each test below creates its own fresh createAuth() instance for the
// same reason as the discovery-failure-handling tests above: `discovered` is
// cached per closure, so a shared instance would only ever call
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
    // Loopback host, so this exercises only the allowInsecureHttp/NODE_ENV
    // logic, not the hostname allowlist (covered separately below).
    const instance = freshAuth({ issuer: 'http://localhost:8080' });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toBeUndefined();
  });

  it('rejects a plain-http issuer when allowInsecureHttp is unset and NODE_ENV is "test"', async () => {
    process.env.NODE_ENV = 'test';
    // Loopback host, so this exercises only the allowInsecureHttp/NODE_ENV
    // logic, not the hostname allowlist (covered separately below).
    const instance = freshAuth({ issuer: 'http://localhost:8080' });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toBeUndefined();
  });

  it('rejects a plain-http issuer when allowInsecureHttp is explicitly false', async () => {
    delete process.env.NODE_ENV;
    // Loopback host, so this exercises only the allowInsecureHttp/NODE_ENV
    // logic, not the hostname allowlist (covered separately below).
    const instance = freshAuth({
      issuer: 'http://localhost:8080',
      allowInsecureHttp: false
    });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toBeUndefined();
  });

  it('allows a plain-http issuer when allowInsecureHttp is true and NODE_ENV is not production (local dev)', async () => {
    delete process.env.NODE_ENV;
    // Loopback host, so this exercises only the allowInsecureHttp/NODE_ENV
    // logic, not the hostname allowlist (covered separately below).
    const instance = freshAuth({
      issuer: 'http://localhost:8080',
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
    // Loopback host, so this exercises only the allowInsecureHttp/NODE_ENV
    // logic, not the hostname allowlist (covered separately below).
    const instance = freshAuth({
      issuer: 'http://localhost:8080',
      allowInsecureHttp: true
    });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toBeUndefined();
  });

  it('rejects a plain-http issuer on a non-loopback hostname even when allowInsecureHttp is true and NODE_ENV is not production', async () => {
    delete process.env.NODE_ENV;
    // `id.local` is not itself a loopback hostname (not `localhost`,
    // `127.0.0.1`, `[::1]`, nor ending in `.localhost`), so the hostname
    // allowlist must deny this regardless of the flag/NODE_ENV being
    // otherwise permissive.
    const instance = freshAuth({
      issuer: 'http://id.local',
      allowInsecureHttp: true
    });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toBeUndefined();
  });

  it('allows a plain-http issuer on a loopback hostname other than bare "localhost" when allowInsecureHttp is true and NODE_ENV is not production', async () => {
    delete process.env.NODE_ENV;
    // `127.0.0.1` is a loopback address and must be accepted by the hostname
    // allowlist just like `localhost` is.
    const instance = freshAuth({
      issuer: 'http://127.0.0.1:8080',
      allowInsecureHttp: true
    });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toEqual({
      execute: [client.allowInsecureRequests]
    });
  });

  it('allows a plain-http issuer on the IPv6 loopback address when allowInsecureHttp is true and NODE_ENV is not production', async () => {
    delete process.env.NODE_ENV;
    // `new URL('http://[::1]:8080').hostname` keeps the brackets
    // (`'[::1]'`), unlike bracket-free IPv6 forms such as `net.isIP()` output
    // or a socket's `remoteAddress`. Regression test for that exact
    // mismatch: `isLoopbackHost` must compare against `'[::1]'`.
    const instance = freshAuth({
      issuer: 'http://[::1]:8080',
      allowInsecureHttp: true
    });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toEqual({
      execute: [client.allowInsecureRequests]
    });
  });

  it('allows a plain-http issuer on a *.localhost subdomain when allowInsecureHttp is true and NODE_ENV is not production', async () => {
    delete process.env.NODE_ENV;
    // A `*.localhost` subdomain must be accepted by the hostname allowlist
    // just like bare `localhost` is.
    const instance = freshAuth({
      issuer: 'http://zitadel.localhost:8080',
      allowInsecureHttp: true
    });
    const callsBefore = vi.mocked(client.discovery).mock.calls.length;

    await instance.startLogin('/x');

    expect(discoveryExecuteArgOfNextCall(callsBefore)()).toEqual({
      execute: [client.allowInsecureRequests]
    });
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
