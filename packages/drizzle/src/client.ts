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

// Thrown by closeDb() when the underlying pool.end() rejects (e.g. a
// shutdown while a client is still checked out), instead of letting the raw
// pg/pg-pool error reach the caller ungoverned by any wrapper type.
export class DbCloseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DbCloseError';
  }
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
    if (!pool) return;
    try {
      await pool.end();
    } catch (error: unknown) {
      // Deliberately leave cache.pool/cache.db untouched: pg-pool marks the
      // pool as ending the moment end() is called, so this pool can never
      // serve a new connection again regardless of whether end() itself
      // resolves or rejects. Keeping the reference means the next
      // getDb()/getPool() call returns this same (broken) pool instead of
      // silently opening a second one against the same database next to a
      // half-closed first. Every later query or closeDb() retry then fails
      // loudly against pg's own errors (e.g. "Cannot use a pool after
      // calling end on the pool" / "Called end on pool more than once"),
      // never silently.
      throw new DbCloseError('Closing the database pool failed', {
        cause: error
      });
    }
    cache.pool = undefined;
    cache.db = undefined;
  }

  return { db, getDb, getPool, closeDb };
}
