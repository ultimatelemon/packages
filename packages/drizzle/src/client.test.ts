import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    delete process.env.DATABASE_POOL_MAX;
    await client.closeDb();
  });

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
