import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt, loadEncryptionKey } from './index.js';

const KEY = randomBytes(32);
const UNWRAPPED = Symbol.for('@ultimatelemon-eu/crypto.unwrappedKey');

const ENV = {
  ENCRYPTION_KEY_WRAPPED: 'wrapped-ciphertext',
  INFISICAL_KMS_URL: 'http://infisical:8080/',
  INFISICAL_KMS_CLIENT_ID: 'client-id',
  INFISICAL_KMS_CLIENT_SECRET: 'client-secret',
  INFISICAL_KMS_KEY_ID: 'key-id'
};

interface Call {
  url: string;
  init: RequestInit;
}

function stubKms(plaintext = KEY.toString('base64'), decryptStatus = 200) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/universal-auth/login')) {
      return Promise.resolve(Response.json({ accessToken: 'token' }));
    }
    if (decryptStatus !== 200) {
      return Promise.resolve(
        Response.json({ message: 'Forbidden' }, { status: decryptStatus })
      );
    }
    return Promise.resolve(Response.json({ plaintext }));
  });
  return calls;
}

beforeEach(() => {
  delete process.env.ENCRYPTION_KEY;
  Object.assign(process.env, ENV);
});

afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  delete (globalThis as { [UNWRAPPED]?: Buffer })[UNWRAPPED];
  vi.unstubAllGlobals();
});

describe('loadEncryptionKey', () => {
  it('unwraps the key with Infisical KMS', async () => {
    const calls = stubKms();
    await loadEncryptionKey();

    expect(calls.map((c) => c.url)).toEqual([
      'http://infisical:8080/api/v1/auth/universal-auth/login',
      'http://infisical:8080/api/v1/kms/keys/key-id/decrypt'
    ]);
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      ciphertext: 'wrapped-ciphertext'
    });
    expect(new Headers(calls[1].init.headers).get('authorization')).toBe(
      'Bearer token'
    );
  });

  it('opens values sealed with the plain key', async () => {
    process.env.ENCRYPTION_KEY = KEY.toString('base64');
    const sealed = encrypt('secret');
    delete process.env.ENCRYPTION_KEY;

    stubKms();
    await loadEncryptionKey();
    expect(decrypt(sealed)).toBe('secret');
  });

  it('is required before encrypting with a wrapped key', () => {
    expect(() => encrypt('x')).toThrow('await loadEncryptionKey()');
  });

  it('prefers a plain ENCRYPTION_KEY and skips KMS', async () => {
    process.env.ENCRYPTION_KEY = KEY.toString('base64');
    const calls = stubKms();
    await loadEncryptionKey();
    expect(calls).toHaveLength(0);
  });

  it('names the missing settings', async () => {
    delete process.env.INFISICAL_KMS_KEY_ID;
    await expect(loadEncryptionKey()).rejects.toThrow(
      'needs INFISICAL_KMS_KEY_ID'
    );
  });

  it('reports a failed decrypt without leaking secrets', async () => {
    stubKms(undefined, 403);
    const error = await loadEncryptionKey().catch((e: Error) => e);
    expect(String(error)).toContain(
      'Infisical KMS decrypt failed: 403 Forbidden'
    );
    expect(String(error)).not.toContain('client-secret');
  });

  it('rejects an unwrapped key that is not 32 bytes', async () => {
    stubKms(randomBytes(16).toString('base64'));
    await expect(loadEncryptionKey()).rejects.toThrow('got 16 bytes');
  });
});
