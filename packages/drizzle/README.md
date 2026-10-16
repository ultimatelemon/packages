# @ultimatelemon-eu/drizzle

Drizzle on node-postgres, the way every UltimateLemon app wires it: a lazy
database client, helpers to recognise Postgres errors, and migrations at
container start behind an advisory lock.

```bash
npm install @ultimatelemon-eu/drizzle drizzle-orm pg
```

Replaces `@ultimatelemon-eu/drizzle-migrate`. Migrating from it is one import:
`@ultimatelemon-eu/drizzle-migrate` becomes `@ultimatelemon-eu/drizzle/migrate`,
with the same API.

## Client

```ts
// src/db/index.ts
import { createDb } from '@ultimatelemon-eu/drizzle';

import * as schema from './schema';

import type { DbOrTx as DbOrTxOf } from '@ultimatelemon-eu/drizzle';

export const { db, getPool, closeDb } = createDb({
  schema,
  casing: 'snake_case'
});

export type DbOrTx = DbOrTxOf<typeof schema>;
```

```ts
const rows = await db.select().from(users);
```

Importing the module reads no env and opens no connection. The pool is built
on the first query, so `next build` in a Docker or CI job without
`DATABASE_URL` does not fail or hang on an import, and a test file can import
the module without a database.

A page that queries during the build still needs a database, or it must be
dynamic (`export const dynamic = 'force-dynamic'`).

| Option             | Default         | Does                                                 |
| ------------------ | --------------- | ---------------------------------------------------- |
| `schema`           | required        | Your Drizzle schema, for `db.query` and types        |
| `connectionString` | `$DATABASE_URL` | Read at the first query, not at `createDb`           |
| `pool`             | see below       | Any `pg` `PoolConfig`, merged over the defaults      |
| `cacheKey`         | `'default'`     | Separates two databases in one process               |
| _other_            |                 | Passed to `drizzle()`: `casing`, `logger`, and so on |

Pool defaults: `max` from `$DATABASE_POOL_MAX` (10 when unset, capped at 20),
and `connectionTimeoutMillis: 5000`. Without that timeout, `pg` waits forever
for a database that does not answer.

A `$DATABASE_POOL_MAX` above 20 is clamped to 20 with a `console.warn` naming
both the requested and the applied value. Postgres usually runs on its default
`max_connections = 100`, part of which is reserved, and a rolling deploy has
several instances alive at once — so 20 per instance is ample, while a typo
(`10000` instead of `100`) cannot starve the server. It warns instead of
throwing because the pool is built lazily on the first query: a throw would
only show up at some later request, not at boot or on a health check. A
project that really needs more sets it explicitly via `pool: { max: N }`,
which is not clamped.

Three more defaults bound how long a connection can sit busy once it is
open, so a stuck row lock or a forgotten open transaction cannot hold a pool
connection (and the lock it took) forever:

| Setting                               | Default | Why                                                                                      |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `lock_timeout`                        | `3000`  | How long a statement waits for a row/table lock (e.g. `.for('update')`) before giving up |
| `statement_timeout`                   | `10000` | How long any single statement may run                                                    |
| `idle_in_transaction_session_timeout` | `10000` | How long a transaction may sit open between statements before Postgres ends the session  |

`lock_timeout` must stay strictly below `statement_timeout`: otherwise
`statement_timeout` (`57014 query_canceled`) cancels a lock wait before
`lock_timeout` (`55P03 lock_not_available`) gets the chance to fire, hiding
the more specific error a caller would want to catch.

These are plain `pg` `PoolConfig` fields, sent as Postgres startup
parameters on every connection, so they apply for the life of the session —
including a `.for('update')` row lock — without any `SET`/`SET LOCAL` query
to set them. A project overrides or disables any of them the same way it
already overrides `connectionTimeoutMillis`, through the `pool` option, e.g.
`pool: { statement_timeout: false }` or `pool: { lock_timeout: 0 }`.

A connection pooler running in transaction-pooling mode (e.g. PgBouncer) may
reject or fail to persist unknown startup parameters per client session —
that is a property of the pooler, not of this package, and worth checking
against your own Postgres infrastructure.

`idle_in_transaction_session_timeout` makes Postgres terminate the session
server-side, which `pg` surfaces as an `'error'` event rather than a query
rejection. Left unhandled, that is an unhandled `EventEmitter` error that
crashes the process — for both a client sitting idle in the pool and a
client checked out via `pool.connect()`/a transaction (`pg-pool` only keeps
its own forwarding listener attached while a client is idle in the pool, not
while it is checked out). `createDb` attaches a listener for both cases —
`pool.on('error', ...)` and a per-client listener added on `pool`'s
`'connect'` event — so this package's defaults cannot introduce that crash.

`createDb` returns:

| Member      | Does                                                      |
| ----------- | --------------------------------------------------------- |
| `db`        | The Drizzle database; builds pool and client on first use |
| `getDb()`   | The same client, without the proxy                        |
| `getPool()` | The `pg` pool, for `LISTEN`, raw queries or health checks |
| `closeDb()` | Ends the pool; the next query builds a fresh one          |

The pool lives on `globalThis`, keyed by `cacheKey`. Next.js dev reloads the
module on every change; without this each reload opens another pool until
Postgres refuses connections.

Types: `Db<typeof schema>`, `Tx<typeof schema>` for the argument of
`db.transaction`, and `DbOrTx<typeof schema>` for a function that works both
inside and outside a transaction.

## Errors

```ts
import { isUniqueViolation } from '@ultimatelemon-eu/drizzle';

try {
  await db.insert(users).values(input);
} catch (error: unknown) {
  if (isUniqueViolation(error, 'users_email_key')) {
    return { error: 'Dit e-mailadres is al in gebruik.' };
  }
  throw error;
}
```

| Function                                    | True for                                                        |
| ------------------------------------------- | --------------------------------------------------------------- |
| `isUniqueViolation(error, constraint?)`     | `23505`                                                         |
| `isForeignKeyViolation(error, constraint?)` | `23503`                                                         |
| `isPgError(error, code, constraint?)`       | any SQLSTATE, see `PgErrorCode`                                 |
| `getPgError(error)`                         | returns `{ code, constraint, table, column, detail }` or `null` |

Drizzle wraps the `pg` error in `cause`; these walk that chain. Only a
five-character SQLSTATE counts, so a connection error (`ECONNREFUSED`) is not
mistaken for one. Pass the constraint name when a table has more than one
unique index and the message depends on which one fired.

## Migrations

```ts
// src/db/migrate.ts
import { runMigrationsCli } from '@ultimatelemon-eu/drizzle/migrate';

await runMigrationsCli({ lockKey: 4178233902n });
```

```sh
# docker/entrypoint.sh
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node /app/db/migrate.cjs
fi
exec "$@"
```

Bundle `src/db/migrate.ts` with esbuild into `migrate.cjs` so the runtime image
needs no `tsx` and no `node_modules` for it. It imports only the `migrate`
entry, so the bundle stays small.

| Option             | Default         | Does                          |
| ------------------ | --------------- | ----------------------------- |
| `connectionString` | `$DATABASE_URL` | Postgres connection           |
| `migrationsFolder` | `./drizzle`     | Where Drizzle wrote the SQL   |
| `lockKey`          | `4178233900n`   | Advisory lock key             |
| `lockTimeoutMs`    | `300000`        | How long to wait for the lock |
| `logger`           | `console.info`  | Success line                  |

`runMigrations` throws; `runMigrationsCli` exits 0 or 1, which is what an
entrypoint wants.

### Why a lock

Two containers starting together would run the same `CREATE TABLE`. Whoever
misses the lock waits and then finds nothing left to do — waiting beats
skipping, which would serve traffic against a schema that is not there yet.

The lock sits on its own `Client`, not a pool: Postgres releases a
session-level advisory lock when that connection drops, even on a hard kill. A
row in a table would not.

`lock_timeout` means a container stuck behind a jammed migration fails visibly
instead of hanging.

### Baselining an existing database

A database that ran under another migration tool has no
`drizzle.__drizzle_migrations`, so Drizzle replays the baseline against tables
that already exist. Insert one row to mark it applied instead — the hash is
the sha256 of the migration file, the timestamp is `when` from
`meta/_journal.json`.

## Tests

`npm test` runs the unit tests. With `TEST_DATABASE_URL` set it also runs a
query, a real unique violation, a check that `lock_timeout` arrives as a
session GUC, and a check that a client actually checked out of the pool
keeps its own `'error'` listener, against that database.
