import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEALED = /^v1\.[\w+/=-]+\.[\w+/=-]+\.[\w+/=-]*$/;

let cached: { raw: string; key: Buffer } | null = null;

// Read on first use, not at import, so builds without secrets still work.
function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY is not set');
  if (cached?.raw === raw) return cached.key;

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must be ${KEY_BYTES} bytes of base64, got ${key.length} bytes`
    );
  }
  cached = { raw, key };
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv, {
    authTagLength: TAG_BYTES
  });
  const data = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, data].map(encode).join('.');
}

// Throws when the value was tampered with or sealed under another key.
export function decrypt(sealed: string): string {
  if (!isEncrypted(sealed)) throw new Error('Not an encrypted value');
  const [, iv, tag, data] = sealed.split('.').map(decode) as Buffer[];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Not an encrypted value');
  }

  const decipher = createDecipheriv(ALGORITHM, key(), iv, {
    authTagLength: TAG_BYTES
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8'
  );
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && SEALED.test(value);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function encode(part: string | Buffer): string {
  return typeof part === 'string' ? part : part.toString('base64url');
}

// Node's base64 decoder also reads base64url, so values written as either
// decrypt the same.
function decode(part: string): Buffer {
  return Buffer.from(part, 'base64');
}
