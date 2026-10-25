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

## API

| Function                           | Returns   | Notes                                                  |
| ---------------------------------- | --------- | ------------------------------------------------------ |
| `encrypt(plaintext, { context? })` | `string`  | `v1.<iv>.<tag>.<data>`, base64url, fresh IV every call |
| `decrypt(sealed, { context? })`    | `string`  | Throws on tampering, a wrong key or a non-sealed value |
| `isEncrypted(value)`               | `boolean` | Type guard for the `v1.` format                        |
| `randomToken(bytes=32)`            | `string`  | base64url, for invite links, CSRF, state               |
| `sha256Hex(value)`                 | `string`  | Store a token's hash, not the token                    |

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
