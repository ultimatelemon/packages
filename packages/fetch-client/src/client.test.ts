import { describe, expect, it, vi } from 'vitest';
import {
  buildUrl,
  createFetchClient,
  HttpError,
  parseRetryAfter,
  RateLimitedError,
  TokenBucket
} from './index.js';

describe('TokenBucket', () => {
  it('allows a burst, then refills at the rate that keeps a window under the limit', () => {
    let now = 0;
    const bucket = new TokenBucket(
      { limit: 300, windowMs: 300_000, burst: 40 },
      () => now
    );
    for (let i = 0; i < 40; i++) expect(bucket.tryTake()).toBe(0);
    const wait = bucket.tryTake();
    // (300 - 40) tokens per 300 s is one per ~1154 ms.
    expect(wait).toBeGreaterThan(1100);
    expect(wait).toBeLessThan(1200);
    now += wait;
    expect(bucket.tryTake()).toBe(0);
  });

  it('never hands out more than the limit in one window', () => {
    let now = 0;
    const bucket = new TokenBucket(
      { limit: 300, windowMs: 300_000, burst: 40 },
      () => now
    );
    let taken = 0;
    while (now < 300_000) {
      if (bucket.tryTake() === 0) taken++;
      else now += 100;
    }
    expect(taken).toBeLessThanOrEqual(300);
  });

  it('stops while blocked by a Retry-After', () => {
    let now = 0;
    const bucket = new TokenBucket(
      { limit: 10, windowMs: 1000, burst: 5 },
      () => now
    );
    bucket.block(30_000);
    expect(bucket.tryTake()).toBe(30_000);
    now = 30_000;
    expect(bucket.tryTake()).toBeGreaterThan(0);
  });

  it('rejects instead of waiting longer than maxWaitMs', async () => {
    const bucket = new TokenBucket({
      limit: 10,
      windowMs: 1000,
      burst: 1,
      maxWaitMs: 10
    });
    bucket.block(60_000);
    await expect(bucket.take()).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('12')).toBe(12_000);
    expect(
      parseRetryAfter('Tue, 06 Oct 2026 07:00:30 GMT', Date.UTC(2026, 9, 6, 7))
    ).toBe(30_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('buildUrl', () => {
  it('skips empty values and repeats arrays', () => {
    const url = buildUrl('https://x.test/api/', '/v2', {
      a: 1,
      b: undefined,
      c: null,
      d: ['x', 'y'],
      e: true
    });
    expect(url.toString()).toBe('https://x.test/api/v2?a=1&d=x&d=y&e=true');
  });
});

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('createFetchClient', () => {
  it('sends headers and parses JSON', async () => {
    const fetch = vi.fn((_url: URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-key')).toBe('secret');
      return Promise.resolve(json(200, { ok: true }));
    });
    const client = createFetchClient({
      baseUrl: 'https://x.test',
      headers: { 'x-key': 'secret' },
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    await expect(client.get('/a')).resolves.toEqual({ ok: true });
  });

  it('retries a 5xx once', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, { n: 1 }));
    const client = createFetchClient({ baseUrl: 'https://x.test', fetch });
    await expect(client.get('/a')).resolves.toEqual({ n: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry with an HttpError', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(json(500, { message: 'x' })));
    const client = createFetchClient({ baseUrl: 'https://x.test', fetch });
    await expect(client.get('/a')).rejects.toMatchObject({ status: 500 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx', async () => {
    const fetch = vi.fn().mockResolvedValue(json(400, { message: 'bad' }));
    const client = createFetchClient({ baseUrl: 'https://x.test', fetch });
    await expect(client.get('/a')).rejects.toBeInstanceOf(HttpError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('turns a 429 into RateLimitedError with the Retry-After', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json(429, {}, { 'retry-after': '7' }));
    const client = createFetchClient({
      baseUrl: 'https://x.test',
      fetch,
      rateLimit: { limit: 300, windowMs: 300_000, burst: 40, maxWaitMs: 1 }
    });
    await expect(client.get('/a')).rejects.toMatchObject({
      retryAfterMs: 7000
    });
    // The bucket is now blocked, so the next call fails without a request.
    await expect(client.get('/a')).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a timeout', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const client = createFetchClient({ baseUrl: 'https://x.test', fetch });
    await expect(client.get('/a')).rejects.toMatchObject({ status: 504 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure once', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(200, []));
    const client = createFetchClient({ baseUrl: 'https://x.test', fetch });
    await expect(client.get('/a')).resolves.toEqual([]);
  });
});
