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
  // The in-flight closeDb() attempt, if one is currently running. Lets a
  // second, overlapping closeDb() call (e.g. a SIGTERM and a SIGINT handler
  // both calling closeDb() without awaiting one before the other) share the
  // outcome of the one real pool.end() call already in progress, instead of
  // calling pool.end() a second time on the same pool and getting a
  // spurious rejection purely because of the race.
  closing?: Promise<void>;
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

// Thrown by closeDb() when the underlying pool.end() rejects, instead of
// letting the raw pg/pg-pool error reach the caller ungoverned by any
// wrapper type. In practice this happens when pool.end() is called on a
// pool that is already ending or has already ended -- pg-pool's own
// "Called end on pool more than once" -- for example a closeDb() retry
// after an earlier attempt on this same pool already failed (a successful
// attempt clears cache.pool, so there is nothing left to retry against), or
// something else having called pool.end()/getPool().end() directly. Two
// closeDb() calls that overlap *while the first is still in flight* do not
// hit this: see the `cache.closing` dedup below, which makes them share the
// single underlying pool.end() call instead of each issuing their own.
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
    // A closeDb() call already in flight owns the one real pool.end() call;
    // share its outcome instead of calling pool.end() again on the same
    // pool, which would otherwise reject with pg-pool's own "Called end on
    // pool more than once" purely because of the overlap, not because of an
    // actual close failure.
    cache.closing ??= (async () => {
      try {
        await pool.end();
      } catch (error: unknown) {
        // Deliberately leave cache.pool/cache.db untouched: pg-pool marks
        // the pool as ending the moment end() is called, so this pool can
        // never serve a new connection again regardless of whether end()
        // itself resolves or rejects. Keeping the reference means the next
        // getDb()/getPool() call returns this same (broken) pool instead of
        // silently opening a second one against the same database next to a
        // half-closed first. Every later query or closeDb() retry then
        // fails loudly against pg's own errors (e.g. "Cannot use a pool
        // after calling end on the pool" / "Called end on pool more than
        // once"), never silently.
        throw new DbCloseError('Closing the database pool failed', {
          cause: error
        });
      } finally {
        // Clear the in-flight marker once this attempt has settled (either
        // way), so the next closeDb() call -- a sequential retry after a
        // failure, or a fresh close after a later getPool() rebuilt the
        // pool -- starts its own attempt instead of replaying this one.
        cache.closing = undefined;
      }
      cache.pool = undefined;
      cache.db = undefined;
    })();

    return cache.closing;
  }

  return { db, getDb, getPool, closeDb };
}
