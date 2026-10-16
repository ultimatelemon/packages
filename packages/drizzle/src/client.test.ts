import { EventEmitter } from 'node:events';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb } from './client.js';
import { isUniqueViolation } from './errors.js';

const schema = {};
let key = 0;

function nextKey(): string {
  key += 1;
  return `test-${key}`;
}

describe('createDb', () => {
  const original = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  // DATABASE_POOL_MAX is only ever set from within a test body below; clean
  // it up here (not inline in each test) so a failing assertion never leaks
  // it into a later test. Restoring mocks here too means a `console.warn`
  // spy survives a failed assertion in the same test without leaking into
  // the next one (an inline `mockRestore()` after the assertions would not).
  afterEach(() => {
    delete process.env.DATABASE_POOL_MAX;
    vi.restoreAllMocks();
  });

  it('reads no env and opens no pool until the first use', () => {
    const client = createDb({ schema, cacheKey: nextKey() });
    expect(() => client.getPool()).toThrow('DATABASE_URL is missing');
    expect(() => client.db.select).toThrow('DATABASE_URL is missing');
  });

  it('reads DATABASE_URL at first use, not at creation', async () => {
    const client = createDb({ schema, cacheKey: nextKey() });
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/app';
    expect(client.getPool().options.connectionString).toBe(
      process.env.DATABASE_URL
    );
    await client.closeDb();
  });

  it('applies the pool defaults and lets options override them', async () => {
    process.env.DATABASE_POOL_MAX = '3';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app',
      pool: {
        connectionTimeoutMillis: 1000,
        statement_timeout: 20000,
        lock_timeout: 500,
        idle_in_transaction_session_timeout: 20000
      }
    });
    const pool = client.getPool();
    expect(pool.options.max).toBe(3);
    expect(pool.options.connectionTimeoutMillis).toBe(1000);
    // Callers can override (or disable) each package default via the
    // existing `pool` option, exactly like `connectionTimeoutMillis`.
    expect(pool.options.statement_timeout).toBe(20000);
    expect(pool.options.lock_timeout).toBe(500);
    expect(pool.options.idle_in_transaction_session_timeout).toBe(20000);
    // A DATABASE_POOL_MAX value that is already within the upper bound must
    // not trigger the "value was capped" warning.
    expect(warnSpy).not.toHaveBeenCalled();
    await client.closeDb();
  });

  it('lets the explicit pool.max option bypass the DATABASE_POOL_MAX cap', async () => {
    process.env.DATABASE_POOL_MAX = '10000';
    // poolMax() still runs (and so still warns) even though the explicit
    // `pool.max` below overrides its result; silence that expected warning,
    // it is not what this test is about.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app',
      pool: { max: 50 }
    });
    const pool = client.getPool();
    // The explicit `pool` option is spread after `max: poolMax()`, so it
    // always wins -- the cap only guards against a bare env-var typo, not a
    // deliberate, code-reviewed override.
    expect(pool.options.max).toBe(50);
    await client.closeDb();
  });

  it('caps DATABASE_POOL_MAX at the hard upper bound of 20', async () => {
    process.env.DATABASE_POOL_MAX = '10000';
    // Silence the expected warning; it is asserted on separately below.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const pool = client.getPool();
    expect(pool.options.max).toBe(20);
    await client.closeDb();
  });

  it('warns exactly once, naming both the requested and the applied value, when DATABASE_POOL_MAX exceeds the upper bound', async () => {
    process.env.DATABASE_POOL_MAX = '10000';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    client.getPool();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The message wording is an implementation detail; only the two numbers
    // (requested and applied) are part of the contract. Match on word
    // boundaries so e.g. a requested value of "2000" could not satisfy the
    // assertion for the applied value "20" by mere substring overlap.
    const message = warnSpy.mock.calls[0]?.join(' ') ?? '';
    expect(message).toMatch(/\b10000\b/);
    expect(message).toMatch(/\b20\b/);
    await client.closeDb();
  });

  it.each([
    ['missing/undefined', undefined],
    ['empty string', ''],
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-1']
  ])(
    'stays silent and falls back to the default pool max 10 when DATABASE_POOL_MAX is %s',
    async (_label, value) => {
      if (value === undefined) {
        delete process.env.DATABASE_POOL_MAX;
      } else {
        process.env.DATABASE_POOL_MAX = value;
      }
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const client = createDb({
        schema,
        cacheKey: nextKey(),
        connectionString: 'postgresql://localhost/app'
      });
      const pool = client.getPool();
      expect(pool.options.max).toBe(10);
      expect(warnSpy).not.toHaveBeenCalled();
      await client.closeDb();
    }
  );

  it('defaults statement_timeout, lock_timeout and idle_in_transaction_session_timeout when not overridden', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const pool = client.getPool();
    // Package defaults per PKG-11: a stuck row lock (`.for('update')`) or a
    // forgotten open transaction must not hold a pool connection forever.
    // lock_timeout (3000) is strictly smaller than statement_timeout (10000)
    // so a lock wait surfaces as 55P03 before statement_timeout (57014)
    // would cancel the query first.
    expect(pool.options.statement_timeout).toBe(10000);
    expect(pool.options.lock_timeout).toBe(3000);
    expect(pool.options.idle_in_transaction_session_timeout).toBe(10000);
    await client.closeDb();
  });

  it('does not crash when the pool emits an error (e.g. a server-killed idle client)', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const pool = client.getPool();
    // idle_in_transaction_session_timeout lets Postgres terminate a session
    // (25P03) while its client sits idle in the pool; pg surfaces that as an
    // 'error' event on the Pool. Without a listener that is an unhandled
    // EventEmitter error that would crash the process.
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    expect(() => pool.emit('error', new Error('boom'))).not.toThrow();
    await client.closeDb();
  });

  it('attaches an error listener to every client via the pool "connect" event', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const pool = client.getPool();
    // A client checked out via pool.connect() (or drizzle's transaction())
    // loses pg-pool's own forwarding error-listener for the whole duration
    // of the checkout -- that is exactly the window
    // idle_in_transaction_session_timeout targets. pg-pool fires 'connect'
    // on the Pool with the real client once per new physical connection, so
    // drive that event with a stand-in EventEmitter (no real connection
    // needed) and check the package's handler actually attaches a listener
    // that survives a synthetic error, not just that something is
    // registered on the Pool's own 'connect' event.
    const fakeClient = new EventEmitter();
    pool.emit('connect', fakeClient);
    expect(fakeClient.listenerCount('error')).toBeGreaterThan(0);
    expect(() => fakeClient.emit('error', new Error('boom'))).not.toThrow();
    await client.closeDb();
  });

  it('shares one pool per cache key, surviving a second createDb', async () => {
    const cacheKey = nextKey();
    const options = {
      schema,
      cacheKey,
      connectionString: 'postgresql://localhost/app'
    };
    const first = createDb(options);
    const second = createDb(options);
    const other = createDb({ ...options, cacheKey: nextKey() });

    expect(second.getPool()).toBe(first.getPool());
    expect(second.getDb()).toBe(first.getDb());
    expect(other.getPool()).not.toBe(first.getPool());

    await first.closeDb();
    await other.closeDb();
  });

  it('builds a fresh pool after closeDb', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const before = client.getPool();
    await client.closeDb();
    expect(client.getPool()).not.toBe(before);
    await client.closeDb();
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('createDb against Postgres', () => {
  it('queries through the lazy db and recognises a unique violation', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: testDatabaseUrl
    });
    try {
      const result = await client.db.execute(sql`select 1 as one`);
      expect(result.rows[0]).toEqual({ one: 1 });

      const table = sql.identifier(`drizzle_pkg_test_${process.pid}`);
      await client.db.execute(sql`create table ${table} (id int primary key)`);
      try {
        await client.db.execute(sql`insert into ${table} values (1)`);
        const error: unknown = await client.db
          .execute(sql`insert into ${table} values (1)`)
          .catch((caught: unknown) => caught);
        expect(isUniqueViolation(error)).toBe(true);
      } finally {
        await client.db.execute(sql`drop table ${table}`);
      }
    } finally {
      await client.closeDb();
    }
  });

  it('keeps an error listener on a client that is actually checked out of the pool', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: testDatabaseUrl
    });
    const pool = client.getPool();
    // pg-pool's _acquireClient removes the client's own forwarding
    // 'error' listener the moment pool.connect() hands the client out, and
    // only re-attaches it on release. A session killed by
    // idle_in_transaction_session_timeout is, by definition, idle *inside
    // an open transaction* -- i.e. exactly during that checked-out window.
    // If nothing else is listening, pg emits 'error' straight on the bare
    // Client, which is an unhandled EventEmitter error that crashes the
    // process. So this must go through the real pool.connect() acquire
    // path (not a synthetic pool.emit) against a real new connection, to
    // actually exercise pg-pool's listener bookkeeping.
    try {
      const pgClient = await pool.connect();
      try {
        expect(pgClient.listenerCount('error')).toBeGreaterThan(0);
        expect(() => pgClient.emit('error', new Error('boom'))).not.toThrow();
      } finally {
        pgClient.release();
      }
    } finally {
      await client.closeDb();
    }
  });

  it('sends lock_timeout as a session GUC via the pool startup parameters', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: testDatabaseUrl
    });
    try {
      // Postgres normalises a lock_timeout given in milliseconds to a
      // readable unit in current_setting(); 3000 ms comes back as '3s'.
      const result = await client.db.execute(
        sql`select current_setting('lock_timeout') as v`
      );
      expect(result.rows[0]).toEqual({ v: '3s' });
    } finally {
      await client.closeDb();
    }
  });
});
