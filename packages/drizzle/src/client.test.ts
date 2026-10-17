import { EventEmitter } from 'node:events';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, DbCloseError } from './client.js';
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

  // Any test below that calls vi.useFakeTimers() must not leak fake timers
  // into a later test (which would otherwise hang or fail for an unrelated
  // reason). Restore real timers unconditionally after every test, not just
  // the ones that use fake timers, so a failed assertion inside a
  // fake-timer test can never skip this cleanup.
  afterEach(() => {
    vi.useRealTimers();
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

  it('rejects with a DbCloseError carrying the underlying pg-pool failure as `cause` when pool.end() fails', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const pool = client.getPool();
    // End the pool directly, outside of closeDb(), so the pool.end() call
    // closeDb() makes internally hits an already-ended pg Pool. pg-pool
    // rejects a second end() (e.g. "Called end on pool more than once"),
    // which is the real-world case closeDb() must surface, not swallow.
    await pool.end();

    let caught: unknown;
    try {
      await client.closeDb();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DbCloseError);
    const dbCloseError = caught as DbCloseError;
    // The original pg-pool error must be reachable via `cause`, not
    // discarded, and must not just be the DbCloseError pointing at itself.
    // pg-pool's own message for ending an already-ended pool confirms this
    // is the real underlying failure, not some unrelated stand-in error.
    expect(dbCloseError.cause).toBeInstanceOf(Error);
    expect(dbCloseError.cause).not.toBe(dbCloseError);
    expect((dbCloseError.cause as Error).message).toMatch(
      /Called end on pool more than once/
    );
  });

  it('keeps serving the same pool from getPool() after a failed closeDb(), instead of silently opening a second one', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const poolBeforeFailedClose = client.getPool();
    // Same double-end setup as above: makes the internal pool.end() inside
    // closeDb() reject.
    await poolBeforeFailedClose.end();

    await expect(client.closeDb()).rejects.toBeInstanceOf(DbCloseError);

    // A failed closeDb() must leave the cached pool untouched, so the next
    // getPool()/getDb() keeps returning the (broken) pool the caller
    // already knows about, rather than lazily creating a fresh one behind
    // their back.
    expect(client.getPool()).toBe(poolBeforeFailedClose);
  });

  it('retries pool.end() and throws a fresh DbCloseError on a sequential closeDb() call after an earlier attempt already failed', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const pool = client.getPool();
    await pool.end();

    let firstError: unknown;
    try {
      await client.closeDb();
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(DbCloseError);

    // The first attempt already fully settled (this is not an overlap), so
    // a second, later closeDb() call must retry pool.end() for itself
    // rather than replaying the first attempt's outcome -- "fail loud every
    // time", not a silent success or a memoised failure.
    let secondError: unknown;
    try {
      await client.closeDb();
    } catch (error) {
      secondError = error;
    }
    expect(secondError).toBeInstanceOf(DbCloseError);
    expect(secondError).not.toBe(firstError);
    expect((secondError as DbCloseError).cause).not.toBe(
      (firstError as DbCloseError).cause
    );
  });

  it('resolves both calls when closeDb() is invoked twice concurrently without awaiting the first (e.g. SIGTERM + SIGINT racing)', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    client.getPool();

    // Deliberately do not await the first call before starting the second:
    // this is the exact overlap a SIGTERM handler and a SIGINT handler
    // racing each other would produce. pg-pool's real Pool.end() sets
    // `this.ending = true` synchronously, before its own await point, so a
    // second overlapping closeDb() call must not perform a second real
    // pool.end() and must not see a spurious "Called end on pool more than
    // once" rejection just because the first call's pool.end() promise
    // hasn't settled yet.
    const first = client.closeDb();
    const second = client.closeDb();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('builds a fresh pool after two overlapping closeDb() calls both settle', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const before = client.getPool();

    const first = client.closeDb();
    const second = client.closeDb();
    await Promise.all([first, second]);

    // Dedup of the in-flight close must not break the normal post-close
    // rebuild: once both overlapping calls have settled, a fresh pool is
    // still built lazily on next use, same as a single closeDb() call.
    expect(client.getPool()).not.toBe(before);
    await client.closeDb();
  });

  it('rejects both overlapping closeDb() calls with the same DbCloseError when the underlying pool.end() fails', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const pool = client.getPool();
    // Same double-end setup as the single-call failure tests above: end the
    // pool directly so the pool.end() call closeDb() makes internally hits
    // an already-ended pg Pool and rejects.
    await pool.end();

    const [firstOutcome, secondOutcome] = await Promise.allSettled([
      client.closeDb(),
      client.closeDb()
    ]);

    expect(firstOutcome.status).toBe('rejected');
    expect(secondOutcome.status).toBe('rejected');
    const firstError = (firstOutcome as PromiseRejectedResult).reason;
    const secondError = (secondOutcome as PromiseRejectedResult).reason;

    expect(firstError).toBeInstanceOf(DbCloseError);
    expect(secondError).toBeInstanceOf(DbCloseError);
    // Both overlapping calls must share the outcome of the single in-flight
    // pool.end() attempt, not each trigger their own separate pool.end()
    // call (which would produce unrelated/independent errors instead of the
    // same underlying cause).
    expect(secondError).toBe(firstError);
    expect((secondError as DbCloseError).cause).toBe(
      (firstError as DbCloseError).cause
    );
  });

  // PKG-18: closeDb() must not hang forever on a checked-out client (a
  // forgotten pool.connect() without release, or a never-committed
  // transaction) that keeps pg-pool's own pool.end() pending indefinitely.
  // pg-pool's real pool.end() only settles once every checked-out client has
  // been released, so stubbing it to never settle at all is the accurate
  // stand-in for that scenario without needing a real stuck connection.

  it('resolves closeDb() within the fixed close timeout instead of hanging forever when pool.end() never settles (e.g. a client still checked out)', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const pool = client.getPool();
    // Never resolves and never rejects: exactly pg-pool's own behaviour for
    // pool.end() while at least one client is still checked out.
    // mockImplementation (not mockReturnValue): pg's `end()` is overloaded
    // (`end(): Promise<void>` and `end(callback): void`), and
    // mockReturnValue's parameter type resolves against the callback
    // overload, rejecting a Promise<void> argument.
    vi.spyOn(pool, 'end').mockImplementation(() => new Promise<void>(() => {}));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.useFakeTimers();
    const closePromise = client.closeDb();
    // Advance by the documented timeout constant (CLOSE_TIMEOUT_MS = 10_000
    // in client.ts); a real wall-clock wait of 10s has no place in a unit
    // test, so fake timers are mandatory here.
    await vi.advanceTimersByTimeAsync(10_000);

    // closeDb() must resolve (not reject) once the timeout gives up waiting
    // on the still-pending pool.end() -- a hanging client must not turn a
    // clean shutdown path into a crash.
    await expect(closePromise).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Giving up must also clear the cached pool, so the next getPool() call
    // builds a fresh one instead of returning the one we walked away from.
    expect(client.getPool()).not.toBe(pool);
  });

  it('warns with the cacheKey and the number of still checked-out/waiting clients when the close timeout fires, without leaking connection details', async () => {
    const cacheKey = nextKey();
    const connectionString =
      'postgresql://user:super-secret-password@localhost:5432/app';
    const client = createDb({ schema, cacheKey, connectionString });
    const pool = client.getPool();
    // mockImplementation, see the comment on the identical stub above.
    vi.spyOn(pool, 'end').mockImplementation(() => new Promise<void>(() => {}));
    // totalCount/waitingCount are real pg-pool Pool getters; stub them so the
    // warning's reported numbers can be asserted precisely without needing
    // an actual checked-out client.
    vi.spyOn(pool, 'totalCount', 'get').mockReturnValue(4);
    vi.spyOn(pool, 'waitingCount', 'get').mockReturnValue(2);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.useFakeTimers();
    const closePromise = client.closeDb();
    await vi.advanceTimersByTimeAsync(10_000); // must match CLOSE_TIMEOUT_MS
    await closePromise;

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.join(' ') ?? '';
    // Mentions giving up waiting, which cache/pool it gave up on, and how
    // many clients were still checked out or waiting.
    expect(message.toLowerCase()).toMatch(
      /gave up|giving up|timed out|timeout/
    );
    expect(message).toContain(cacheKey);
    expect(message).toMatch(/\b4\b/);
    expect(message).toMatch(/\b2\b/);
    // Must never leak the connection string, the password inside it, or any
    // query text into a log line.
    expect(message).not.toContain(connectionString);
    expect(message).not.toContain('super-secret-password');
  });

  it('logs a second warning (not an unhandled rejection) when the abandoned pool.end() call eventually rejects after closeDb() already resolved via the timeout', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const pool = client.getPool();
    let rejectPoolEnd!: (error: unknown) => void;
    // Simulates the abandoned real pool.end() call settling (badly) only
    // after closeDb() has already given up on it and resolved.
    // mockImplementation, see the comment on the identical stub above.
    vi.spyOn(pool, 'end').mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPoolEnd = reject;
        })
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      vi.useFakeTimers();
      const closePromise = client.closeDb();
      await vi.advanceTimersByTimeAsync(10_000); // must match CLOSE_TIMEOUT_MS
      await expect(closePromise).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();

      // Settle the abandoned pool.end() promise now, well after closeDb()
      // already resolved. Promise.race already attaches a handler to this
      // promise (so Node would never report it as unhandled regardless of
      // whether client.ts adds its own .catch()); what actually proves
      // client.ts's own `.catch()` ran is the *second* console.warn below
      // naming the late failure -- without it, this rejection would be
      // silently swallowed instead.
      rejectPoolEnd(new Error('connection reset by peer'));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandledRejections).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      const secondMessage = warnSpy.mock.calls[1]?.join(' ') ?? '';
      expect(secondMessage).toMatch(/connection reset by peer/);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  }, 2000);

  it('resolves closeDb() comfortably under the close timeout and does not warn when there are no checked-out clients (no fixed delay on the success path)', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    client.getPool();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const startedAt = performance.now();
    await client.closeDb();
    const elapsedMs = performance.now() - startedAt;

    // A regression that always waits out (part of) the new close-timeout
    // budget, even with nothing to wait for, must fail this assertion; real
    // pool.end() against an unreachable host settles essentially
    // immediately once no client is checked out, so this has generous
    // headroom below CLOSE_TIMEOUT_MS (10_000ms) without being a flaky,
    // razor-thin bound.
    expect(elapsedMs).toBeLessThan(500);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still rejects with a DbCloseError (PKG-16 behaviour) when pool.end() rejects well before the close timeout fires', async () => {
    const client = createDb({
      schema,
      cacheKey: nextKey(),
      connectionString: 'postgresql://localhost/app'
    });
    const pool = client.getPool();
    const poolEndError = new Error('Called end on pool more than once');
    vi.spyOn(pool, 'end').mockRejectedValue(poolEndError);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.useFakeTimers();
    let caught: unknown;
    try {
      // Nothing to advance: the mocked pool.end() rejects on its own
      // microtask, long before the 10s close timeout would ever fire. The
      // race added for PKG-18 must not change this existing PKG-16 outcome.
      await client.closeDb();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DbCloseError);
    expect((caught as DbCloseError).cause).toBe(poolEndError);
    // The timeout branch must not have fired alongside the real rejection.
    expect(warnSpy).not.toHaveBeenCalled();
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
