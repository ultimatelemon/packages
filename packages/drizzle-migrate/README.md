# @ultimatelemon-eu/drizzle-migrate

Applies Drizzle migrations behind a Postgres advisory lock, so a container can
migrate on start without two replicas racing.

```bash
npm install @ultimatelemon-eu/drizzle-migrate
```

```ts
// src/db/migrate.ts
import { runMigrationsCli } from '@ultimatelemon-eu/drizzle-migrate';

await runMigrationsCli({ lockKey: 4178233902n });
```

```sh
# docker/entrypoint.sh
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node /app/db/migrate.cjs
fi
exec "$@"
```

## Options

| Option             | Default         | Does                          |
| ------------------ | --------------- | ----------------------------- |
| `connectionString` | `$DATABASE_URL` | Postgres connection           |
| `migrationsFolder` | `./drizzle`     | Where Drizzle wrote the SQL   |
| `lockKey`          | `4178233900n`   | Advisory lock key             |
| `lockTimeoutMs`    | `300000`        | How long to wait for the lock |
| `logger`           | `console.info`  | Success line                  |

`runMigrations` throws; `runMigrationsCli` exits 0 or 1, which is what an
entrypoint wants.

## Why a lock

Two containers starting together would run the same `CREATE TABLE`. Whoever
misses the lock waits and then finds nothing left to do — waiting beats
skipping, which would serve traffic against a schema that is not there yet.

The lock sits on its own `Client`, not a pool: Postgres releases a
session-level advisory lock when that connection drops, even on a hard kill. A
row in a table would not.

`lock_timeout` means a container stuck behind a jammed migration fails visibly
instead of hanging.

## Baselining an existing database

A database that ran under another migration tool has no
`drizzle.__drizzle_migrations`, so Drizzle replays the baseline against tables
that already exist. Insert one row to mark it applied instead — the hash is
the sha256 of the migration file, the timestamp is `when` from
`meta/_journal.json`.
