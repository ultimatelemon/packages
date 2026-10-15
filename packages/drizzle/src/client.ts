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
  return Number.isInteger(max) && max > 0 ? max : DEFAULT_POOL_MAX;
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
        // A pooled client can be terminated server-side while idle (e.g.
        // idle_in_transaction_session_timeout, 25P03); without a listener
        // that is an unhandled EventEmitter error that crashes the process.
        // pg removes and replaces the client on its own, so there is
        // nothing else to do here.
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
