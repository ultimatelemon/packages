# @ultimatelemon-eu/crypto

Encrypt secrets before they go into the database: API keys, OAuth tokens,
passwords for external systems. AES-256-GCM, Node only, no dependencies.

```bash
npm install @ultimatelemon-eu/crypto
```

```ts
import { decrypt, encrypt } from '@ultimatelemon-eu/crypto';

const sealed = encrypt(apiKey); // 'v1.<iv>.<tag>.<data>'
const apiKey = decrypt(sealed);
```

## Key

`ENCRYPTION_KEY`: 32 random bytes, base64.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Read on first use, not at import, so a build without secrets works. Missing
or not 32 bytes throws; there is no fallback key. Losing the key means losing
every value sealed with it.

## Key from Infisical KMS

Instead of the key itself, the env can hold the key wrapped by an Infisical
KMS key. The app unwraps it once at startup over the internal network and
keeps it in memory; the plain key is then stored nowhere.

```env
ENCRYPTION_KEY_WRAPPED=        # ciphertext from the KMS encrypt endpoint
INFISICAL_KMS_URL=             # e.g. http://platform-infisical-2ijmwq:8080
INFISICAL_KMS_CLIENT_ID=       # machine identity with cryptographic-operator
INFISICAL_KMS_CLIENT_SECRET=
INFISICAL_KMS_KEY_ID=
```

```ts
// src/instrumentation.ts (Next.js), or before the server starts
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { loadEncryptionKey } = await import('@ultimatelemon-eu/crypto');
  await loadEncryptionKey();
}
```

Until `loadEncryptionKey()` has resolved, `encrypt` and `decrypt` throw. A
plain `ENCRYPTION_KEY` wins when both are set and needs no call, so moving
back is a matter of setting it again. If Infisical is down at startup the app
does not start; running instances are unaffected.

Wrapping an existing key keeps every sealed value readable, nothing is
re-encrypted. `plaintext` is the `ENCRYPTION_KEY` value as is:

```bash
curl -X POST "$INFISICAL_KMS_URL/api/v1/kms/keys/$INFISICAL_KMS_KEY_ID/encrypt" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"plaintext\":\"$ENCRYPTION_KEY\"}"
```

## API

| Function                           | Returns   | Notes                                                    |
| ---------------------------------- | --------- | -------------------------------------------------------- |
| `loadEncryptionKey()`              | `Promise` | Unwraps `ENCRYPTION_KEY_WRAPPED`; no-op with a plain key |
| `encrypt(plaintext, { context? })` | `string`  | `v1.<iv>.<tag>.<data>`, base64url, fresh IV every call   |
| `decrypt(sealed, { context? })`    | `string`  | Throws on tampering, a wrong key or a non-sealed value   |
| `isEncrypted(value)`               | `boolean` | Type guard for the `v1.` format                          |
| `randomToken(bytes=32)`            | `string`  | base64url, for invite links, CSRF, state                 |
| `sha256Hex(value)`                 | `string`  | Store a token's hash, not the token                      |

`decrypt` also reads the same format written with standard base64, which is
what Cellar stored before this package.

Store sealed values in a `text` column.

## Context

Pass the row a value belongs to as `context`, and it only decrypts with that
same context. A sealed password copied into another user's row then fails
instead of opening their mailbox. The context is not stored; supply it again
when decrypting.

```ts
const sealed = encrypt(password, { context: `${userId}:${accountId}` });
const password = decrypt(sealed, { context: `${userId}:${accountId}` });
```
