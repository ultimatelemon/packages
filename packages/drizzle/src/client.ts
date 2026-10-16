import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { DrizzleConfig } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolConfig } from 'pg';

type Schema = Record<string, unknown>;

export type Db<TSchema extends Schema> = NodePgDatabase<TSchema> & {
  $client: Pool;
};
export type Tx<TSchema extends Schema> = Parameters<
  Parameters<Db<TSchema>['transaction']>[0]
>[0];
export type DbOrTx<TSchema extends Schema> = Db<TSchema> | Tx<TSchema>;

export interface CreateDbOptions<TSchema extends Schema> extends Omit<
  DrizzleConfig<TSchema>,
  'schema'
> {
  schema: TSchema;
  connectionString?: string;
  pool?: Omit<PoolConfig, 'connectionString'>;
  cacheKey?: string;
}

export interface DbClient<TSchema extends Schema> {
  db: Db<TSchema>;
  getDb: () => Db<TSchema>;
  getPool: () => Pool;
  closeDb: () => Promise<void>;
}

interface Cache<TSchema extends Schema> {
  pool?: Pool;
  db?: Db<TSchema>;
}

const DEFAULT_POOL_MAX = 10;
// DATABASE_POOL_MAX is an env var, so a typo (10000 instead of 100) is one
// keystroke away and would otherwise be handed straight to pg. Postgres runs
// on its default max_connections=100 in most of our setups -- including the
// CI postgres service, see shared-actions/.github/workflows/node-quality.yml --
// and part of that budget is already reserved for superuser/maintenance
// connections. With several instances of the same app alive at once during a
// rolling deploy, 20 connections per instance is still plenty of headroom for
// any app we run, while keeping a single typo from starving the server.
const MAX_POOL_MAX = 20;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
// lock_timeout must stay strictly smaller than statement_timeout: otherwise
// statement_timeout (57014 query_canceled) cancels a lock wait before
// lock_timeout (55P03 lock_not_available) can fire, hiding the more specific
// error a caller would want to recognise. A caller can already match on the
// raw SQLSTATE via isPgError(error, '55P03'); ULT-3225 proposes adding
// those codes to PgErrorCode, which this ordering is chosen to support.
const DEFAULT_LOCK_TIMEOUT_MS = 3_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

function poolMax(): number {
  const max = Number(process.env.DATABASE_POOL_MAX);
  if (!Number.isInteger(max) || max <= 0) {
    return DEFAULT_POOL_MAX;
  }
  if (max > MAX_POOL_MAX) {
    // Warn rather than throw: the pool is built lazily on the first query, so
    // a throw here would surface at an arbitrary request instead of at boot.
    console.warn(
      `DATABASE_POOL_MAX=${max} exceeds the maximum of ${MAX_POOL_MAX}; using ${MAX_POOL_MAX}.`
    );
    return MAX_POOL_MAX;
  }
  return max;
}

export function createDb<TSchema extends Schema>(
  options: CreateDbOptions<TSchema>
): DbClient<TSchema> {
  const {
    schema,
    connectionString,
    pool: poolConfig,
    cacheKey = 'default',
    ...config
  } = options;

  const slot = Symbol.for(`@ultimatelemon-eu/drizzle:${cacheKey}`);
  const store = globalThis as unknown as Record<symbol, Cache<TSchema>>;
  const cache = (store[slot] ??= {});

  function getPool(): Pool {
    if (!cache.pool) {
      const url = connectionString ?? process.env.DATABASE_URL;
      if (!url) {
        throw new Error('DATABASE_URL is missing');
      }
      cache.pool = new Pool({
        max: poolMax(),
        connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
        statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
        lock_timeout: DEFAULT_LOCK_TIMEOUT_MS,
        idle_in_transaction_session_timeout:
          DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
        ...poolConfig,
        connectionString: url
      });
      cache.pool.on('error', () => {
        // A client idling *in the pool* can be terminated server-side (e.g.
        // idle_in_transaction_session_timeout, 25P03); pg-pool forwards
        // that as an 'error' event on the Pool itself. Without a listener
        // here that is an unhandled EventEmitter error that crashes the
        // process. pg-pool removes and replaces the client on its own, so
        // there is nothing else to do here.
      });
      cache.pool.on('connect', (client) => {
        // pg-pool detaches its own forwarding listener from a client for
        // the entire time it is checked out (pool.connect(), or
        // drizzle-orm's transaction() helper, which calls that internally)
        // and only re-attaches it once the client is released back to the
        // pool. idle_in_transaction_session_timeout terminates the session
        // (25P03) while the client sits idle *inside an open transaction* --
        // exactly that checked-out window. Without a listener on the client
        // itself, pg would emit 'error' directly on the bare client with
        // nothing listening, crashing the process. 'connect' fires once per
        // new physical connection, before it is first checked out, so a
        // listener added here is a distinct function from pg-pool's own and
        // survives every later checkout/release cycle.
        client.on('error', () => {
          // See the Pool-level listener above: a checked-out client
          // terminated server-side would otherwise emit an unhandled
          // 'error' directly on the client.
        });
      });
    }
    return cache.pool;
  }

  function getDb(): Db<TSchema> {
    cache.db ??= drizzle(getPool(), { ...config, schema });
    return cache.db;
  }

  const db = new Proxy({} as Db<TSchema>, {
    get(_target, prop) {
      const real = getDb();
      const value: unknown = Reflect.get(real, prop, real);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(real)
        : value;
    }
  });

  async function closeDb(): Promise<void> {
    const pool = cache.pool;
    cache.pool = undefined;
    cache.db = undefined;
    if (pool) {
      await pool.end();
    }
  }

  return { db, getDb, getPool, closeDb };
}
