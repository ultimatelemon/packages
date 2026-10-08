import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decrypt,
  encrypt,
  isEncrypted,
  randomToken,
  sha256Hex
} from './index.js';

const KEY = randomBytes(32);

function sealWith(
  key: Buffer,
  plaintext: string,
  encoding: 'base64' | 'base64url'
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  return ['v1', iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === 'string' ? p : p.toString(encoding)))
    .join('.');
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY.toString('base64');
});

afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe('encrypt / decrypt', () => {
  it('round-trips, with a fresh IV every time', () => {
    const a = encrypt('live_abc123');
    const b = encrypt('live_abc123');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\./);
    expect(decrypt(a)).toBe('live_abc123');
    expect(decrypt(b)).toBe('live_abc123');
  });

  it('handles empty and non-ASCII input', () => {
    expect(decrypt(encrypt(''))).toBe('');
    expect(decrypt(encrypt('wachtwoord €✓'))).toBe('wachtwoord €✓');
  });

  it('reads values written with base64 and with base64url', () => {
    // Long enough that both alphabets' special characters show up.
    const plaintext = 'x'.repeat(200);
    expect(decrypt(sealWith(KEY, plaintext, 'base64'))).toBe(plaintext);
    expect(decrypt(sealWith(KEY, plaintext, 'base64url'))).toBe(plaintext);
  });

  it('rejects tampered data', () => {
    const parts = encrypt('secret').split('.');
    const data = Buffer.from(parts[3], 'base64url');
    data[0] ^= 1;
    parts[3] = data.toString('base64url');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });

  it('rejects a value sealed under another key', () => {
    const sealed = sealWith(randomBytes(32), 'secret', 'base64url');
    expect(() => decrypt(sealed)).toThrow();
  });

  it('rejects anything that is not a sealed value', () => {
    expect(() => decrypt('plain-api-key')).toThrow('Not an encrypted value');
    expect(() => decrypt('v1.AAAA.AAAA.AAAA')).toThrow(
      'Not an encrypted value'
    );
  });
});

describe('ENCRYPTION_KEY', () => {
  it('is required', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt('x')).toThrow('ENCRYPTION_KEY is not set');
  });

  it('must be 32 bytes', () => {
    process.env.ENCRYPTION_KEY = randomBytes(16).toString('base64');
    expect(() => encrypt('x')).toThrow('got 16 bytes');
  });

  it('is re-read when it changes', () => {
    const sealed = encrypt('secret');
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => decrypt(sealed)).toThrow();
  });
});

describe('isEncrypted', () => {
  it('tells sealed values from plaintext', () => {
    expect(isEncrypted(encrypt('x'))).toBe(true);
    expect(isEncrypted('live_abc123')).toBe(false);
    expect(isEncrypted('enc:v1:abc')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});

describe('randomToken', () => {
  it('is base64url of the requested length', () => {
    expect(randomToken()).toMatch(/^[\w-]{43}$/);
    expect(randomToken(9)).toMatch(/^[\w-]{12}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe('sha256Hex', () => {
  it('matches the known digest', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});
