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

// On globalThis, not in module scope: Next.js bundles instrumentation and route
// handlers separately, each with its own copy of this module.
const UNWRAPPED = Symbol.for('@ultimatelemon-eu/crypto.unwrappedKey');
const store = globalThis as { [UNWRAPPED]?: Buffer };

// Read on first use, not at import, so builds without secrets still work.
function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    const unwrapped = store[UNWRAPPED];
    if (unwrapped) return unwrapped;
    if (process.env.ENCRYPTION_KEY_WRAPPED) {
      throw new Error(
        'ENCRYPTION_KEY_WRAPPED is set but not unwrapped: await loadEncryptionKey() at startup'
      );
    }
    throw new Error('ENCRYPTION_KEY is not set');
  }
  if (cached?.raw === raw) return cached.key;

  const key = parseKey(raw, 'ENCRYPTION_KEY');
  cached = { raw, key };
  return key;
}

function parseKey(base64: string, name: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${name} must be ${KEY_BYTES} bytes of base64, got ${key.length} bytes`
    );
  }
  return key;
}

const KMS_ENV = [
  'INFISICAL_KMS_URL',
  'INFISICAL_KMS_CLIENT_ID',
  'INFISICAL_KMS_CLIENT_SECRET',
  'INFISICAL_KMS_KEY_ID'
] as const;

/**
 * Unwraps ENCRYPTION_KEY_WRAPPED with Infisical KMS and keeps the key in
 * memory for encrypt/decrypt. Call once at startup, before serving requests.
 * Does nothing when ENCRYPTION_KEY is set, so a plain key still works.
 */
export async function loadEncryptionKey(): Promise<void> {
  if (process.env.ENCRYPTION_KEY) {
    key();
    return;
  }
  const wrapped = process.env.ENCRYPTION_KEY_WRAPPED;
  if (!wrapped) throw new Error('ENCRYPTION_KEY is not set');

  const missing = KMS_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `ENCRYPTION_KEY_WRAPPED needs ${missing.join(', ')} to be set`
    );
  }
  const env = process.env as Record<(typeof KMS_ENV)[number], string>;
  const base = env.INFISICAL_KMS_URL.replace(/\/+$/, '');

  const { accessToken } = await kmsPost<{ accessToken: string }>(
    `${base}/api/v1/auth/universal-auth/login`,
    {
      clientId: env.INFISICAL_KMS_CLIENT_ID,
      clientSecret: env.INFISICAL_KMS_CLIENT_SECRET
    },
    'login'
  );
  const { plaintext } = await kmsPost<{ plaintext: string }>(
    `${base}/api/v1/kms/keys/${encodeURIComponent(env.INFISICAL_KMS_KEY_ID)}/decrypt`,
    { ciphertext: wrapped },
    'decrypt',
    accessToken
  );
  store[UNWRAPPED] = parseKey(plaintext, 'The unwrapped key');
}

async function kmsPost<T>(
  url: string,
  body: object,
  step: string,
  token?: string
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json'
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b: unknown) => (b as { message?: unknown } | null)?.message)
      .catch(() => undefined);
    throw new Error(
      `Infisical KMS ${step} failed: ${res.status}${typeof detail === 'string' ? ` ${detail}` : ''}`
    );
  }
  return (await res.json()) as T;
}

export interface SealOptions {
  /**
   * Bound into the tag but not stored: decrypting needs the same value, so a
   * sealed value copied to another row (another user's id) no longer opens.
   */
  context?: string;
}

export function encrypt(plaintext: string, options: SealOptions = {}): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv, {
    authTagLength: TAG_BYTES
  });
  if (options.context !== undefined) {
    cipher.setAAD(Buffer.from(options.context, 'utf8'));
  }
  const data = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, data].map(encode).join('.');
}

// Throws when the value was tampered with or sealed under another key.
export function decrypt(sealed: string, options: SealOptions = {}): string {
  if (!isEncrypted(sealed)) throw new Error('Not an encrypted value');
  const [, iv, tag, data] = sealed.split('.').map(decode);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Not an encrypted value');
  }

  const decipher = createDecipheriv(ALGORITHM, key(), iv, {
    authTagLength: TAG_BYTES
  });
  if (options.context !== undefined) {
    decipher.setAAD(Buffer.from(options.context, 'utf8'));
  }
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
