import { SignJWT } from 'jose';
import util from 'node:util';
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
    // Left unmocked (no default implementation) on purpose: only the tests
    // that exercise the token-exchange/claims/userinfo paths set these up
    // per-test via `mockResolvedValueOnce`/`mockRejectedValueOnce`, the same
    // way `discovery` is overridden below with `mockRejectedValueOnce`.
    authorizationCodeGrant: vi.fn<typeof actual.authorizationCodeGrant>(),
    fetchUserInfo: vi.fn<typeof actual.fetchUserInfo>()
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

// Checks that a sensitive value carried by an upstream error never surfaces
// through a thrown AuthError's serialized/logged form. Plain
// `JSON.stringify(error)` would not be a meaningful check here, since Error
// instances serialize to `{}` by default (their properties are not own
// enumerable in the way JSON.stringify expects) -- walking
// `Object.getOwnPropertyNames` is what actually inspects `cause`, `message`
// and `stack`. `util.inspect` is checked too because Node prints `.cause`
// there by default (e.g. in an uncaught-exception log or a naive
// `console.error(error)`).
function assertNoLeak(error: unknown, sensitiveValue: string): void {
  const serialized = JSON.stringify(
    error,
    Object.getOwnPropertyNames(error as object)
  );
  expect(serialized).not.toContain(sensitiveValue);
  expect(util.inspect(error, { depth: null })).not.toContain(sensitiveValue);
}

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

  it('wraps a discovery failure from startLogin as AuthError with code discovery_failed, exposing only a filtered cause (name/code), never the raw error', async () => {
    const instance = freshAuth();
    const underlying = new Error('network down');
    vi.mocked(client.discovery).mockRejectedValueOnce(underlying);

    const promise = instance.startLogin('/x');
    await expect(promise).rejects.toBeInstanceOf(AuthError);
    // `underlying` has no `code` property, so the filtered cause must be
    // exactly `{ name: 'Error' }` -- the raw Error instance must not leak
    // through as-is.
    await expect(promise).rejects.toMatchObject({
      code: 'discovery_failed',
      cause: { name: 'Error' }
    });

    const error = (await promise.catch((e: unknown) => e)) as AuthError;
    expect(error.cause).not.toBe(underlying);
  });

  it('wraps a discovery failure from finishLogin as AuthError with code discovery_failed, using a valid flow cookie so flow_expired is not triggered instead', async () => {
    const instance = freshAuth();
    const underlying = new Error('network down');
    vi.mocked(client.discovery).mockRejectedValueOnce(underlying);

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
    await expect(promise).rejects.toMatchObject({
      code: 'discovery_failed',
      cause: { name: 'Error' }
    });

    const error = (await promise.catch((e: unknown) => e)) as AuthError;
    expect(error.cause).not.toBe(underlying);
  });

  it('filters a discovery failure cause down to name and code, never leaking the upstream error message into the thrown AuthError', async () => {
    const instance = freshAuth();
    const sensitive = 'token endpoint said: Bearer abc123-super-secret';
    const upstream = Object.assign(new Error(sensitive), {
      code: 'OAUTH_RESPONSE_BODY_ERROR'
    });
    vi.mocked(client.discovery).mockRejectedValueOnce(upstream);

    const error = (await instance
      .startLogin('/x')
      .catch((e: unknown) => e)) as AuthError;

    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe('discovery_failed');
    // Only `name` and `code` survive -- a real openid-client/oauth4webapi
    // `code` constant is safe to keep, but the message (which may carry
    // response bodies or token material) must not.
    expect(error.cause).toEqual({
      name: 'Error',
      code: 'OAUTH_RESPONSE_BODY_ERROR'
    });
    assertNoLeak(error, sensitive);
  });

  it('wraps an invalid issuer URL as AuthError("discovery_failed") with a filtered cause, instead of letting the raw URL-parsing TypeError escape', async () => {
    const instance = createAuth(() => ({
      issuer: 'not a valid url',
      clientId: 'id',
      clientSecret: 'secret',
      appUrl: 'https://app.example',
      sessionSecret: 'x'.repeat(32),
      cookiePrefix: 'cellar'
    }));

    const error = (await instance
      .startLogin('/x')
      .catch((e: unknown) => e)) as AuthError;

    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe('discovery_failed');
    // `new URL(...)` throws a `TypeError` (Node happens to also set a
    // `code`, but that's an implementation detail we don't want to pin to) --
    // either way, only `name`/`code` may survive, never the raw TypeError
    // instance (which would carry the invalid issuer value in its message).
    expect(error.cause).toMatchObject({ name: 'TypeError' });
    expect(
      Object.keys(error.cause as object).every((key) =>
        ['name', 'code'].includes(key)
      )
    ).toBe(true);
  });

  // Scoped to startLogin()'s call to configuration(): this only shows that
  // `settings()`/`resolve()` throwing on the discovery path is not mistaken
  // for a discovery failure. It does not claim this holds for every step of
  // finishLogin() -- e.g. a `resolve()` throw surfacing while building the
  // callback URL inside the token-exchange try/catch is a separate,
  // pre-existing concern, split off separately.
  it("does not treat the consumer's own config function throwing as a discovery failure: the raw error propagates unwrapped", async () => {
    const instance = createAuth(() => {
      throw new Error('OIDC_ISSUER is not set');
    });

    await expect(instance.startLogin('/x')).rejects.toThrow(
      'OIDC_ISSUER is not set'
    );
    await expect(instance.startLogin('/x')).rejects.not.toBeInstanceOf(
      AuthError
    );
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

// Beyond discovery, three more openid-client/oauth4webapi call sites can
// throw upstream errors during finishLogin(): the token exchange, reading
// claims off the resulting tokens, and (when claims carry no email) the
// userinfo fallback. Each must be wrapped the same way discovery is above:
// a typed AuthError whose `cause` is filtered down to `{ name, code? }`,
// never the raw upstream error. Each test below uses its own fresh
// createAuth() instance for the same reason as the discovery-failure-handling
// tests above (a fresh, not-yet-resolved `discovered` promise), even though
// `authorizationCodeGrant`/`fetchUserInfo` are shared mocks across instances
// -- `mockResolvedValueOnce`/`mockRejectedValueOnce` only ever apply to the
// very next call, which is the one this test triggers.
describe('createAuth - finishLogin cause filtering and success path', () => {
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

  function validFlowCookie(): string {
    return JSON.stringify({
      state: 's',
      nonce: 'n',
      verifier: 'v',
      returnTo: '/'
    });
  }

  it('filters a token-exchange failure cause down to name and code, never leaking the upstream error message into the thrown AuthError', async () => {
    const instance = freshAuth();
    const sensitive = 'token endpoint said: Bearer abc123-super-secret';
    const upstream = Object.assign(new Error(sensitive), {
      code: 'OAUTH_RESPONSE_BODY_ERROR'
    });
    vi.mocked(client.authorizationCodeGrant).mockRejectedValueOnce(upstream);

    const error = (await instance
      .finishLogin(
        'https://app.example/api/auth/callback?code=x',
        validFlowCookie()
      )
      .catch((e: unknown) => e)) as AuthError;

    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe('exchange_failed');
    expect(error.cause).toEqual({
      name: 'Error',
      code: 'OAUTH_RESPONSE_BODY_ERROR'
    });
    assertNoLeak(error, sensitive);
  });

  it('filters a tokens.claims() failure cause down to name and code (no_identity), never leaking the upstream error message into the thrown AuthError', async () => {
    const instance = freshAuth();
    const sensitive = 'id token said: Bearer abc123-super-secret';
    const upstream = Object.assign(new Error(sensitive), {
      code: 'OAUTH_RESPONSE_BODY_ERROR'
    });
    vi.mocked(client.authorizationCodeGrant).mockResolvedValueOnce({
      access_token: 'at',
      claims: () => {
        throw upstream;
      }
    } as unknown as client.TokenEndpointResponse &
      client.TokenEndpointResponseHelpers);

    const error = (await instance
      .finishLogin(
        'https://app.example/api/auth/callback?code=x',
        validFlowCookie()
      )
      .catch((e: unknown) => e)) as AuthError;

    expect(error).toBeInstanceOf(AuthError);
    // No new AuthErrorCode is introduced for this: it reuses the existing
    // `no_identity` code, which previously only covered a missing `sub`.
    expect(error.code).toBe('no_identity');
    expect(error.cause).toEqual({
      name: 'Error',
      code: 'OAUTH_RESPONSE_BODY_ERROR'
    });
    assertNoLeak(error, sensitive);
  });

  it('filters a userinfo-fetch failure cause down to name and code (profile_unreachable), never leaking the upstream error message into the thrown AuthError', async () => {
    const instance = freshAuth();
    const sensitive = 'userinfo endpoint said: Bearer abc123-super-secret';
    const upstream = Object.assign(new Error(sensitive), {
      code: 'OAUTH_RESPONSE_BODY_ERROR'
    });
    // No email on the id-token claims forces the userinfo fallback, which is
    // the call site under test here.
    vi.mocked(client.authorizationCodeGrant).mockResolvedValueOnce({
      access_token: 'at',
      claims: () => ({ sub: 'u1' })
    } as unknown as client.TokenEndpointResponse &
      client.TokenEndpointResponseHelpers);
    vi.mocked(client.fetchUserInfo).mockRejectedValueOnce(upstream);

    const error = (await instance
      .finishLogin(
        'https://app.example/api/auth/callback?code=x',
        validFlowCookie()
      )
      .catch((e: unknown) => e)) as AuthError;

    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe('profile_unreachable');
    expect(error.cause).toEqual({
      name: 'Error',
      code: 'OAUTH_RESPONSE_BODY_ERROR'
    });
    assertNoLeak(error, sensitive);
  });

  it('completes the happy path when claims already carry an email, skipping the userinfo fallback entirely', async () => {
    const instance = freshAuth();
    const authTime = Math.floor(Date.now() / 1000) - 120;
    const fetchUserInfoCallsBefore = vi.mocked(client.fetchUserInfo).mock.calls
      .length;
    vi.mocked(client.authorizationCodeGrant).mockResolvedValueOnce({
      access_token: 'at',
      claims: () => ({
        sub: 'u1',
        email: 'a@b.c',
        name: 'A',
        auth_time: authTime
      })
    } as unknown as client.TokenEndpointResponse &
      client.TokenEndpointResponseHelpers);

    const result = await instance.finishLogin(
      'https://app.example/api/auth/callback?code=x',
      validFlowCookie()
    );

    // An email already present on the id-token claims must short-circuit the
    // userinfo fallback -- it must not be called at all.
    expect(vi.mocked(client.fetchUserInfo).mock.calls.length).toBe(
      fetchUserInfoCallsBefore
    );
    expect(result.session).toEqual({
      sub: 'u1',
      email: 'a@b.c',
      name: 'A',
      authTime
    });
    expect(result.returnTo).toBe('/');
    expect(result.cookies).toHaveLength(2);
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
