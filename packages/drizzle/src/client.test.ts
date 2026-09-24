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
      pool: { connectionTimeoutMillis: 1000 }
    });
    const pool = client.getPool();
    expect(pool.options.max).toBe(3);
    expect(pool.options.connectionTimeoutMillis).toBe(1000);
    delete process.env.DATABASE_POOL_MAX;
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
});
