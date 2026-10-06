/** The slice of a pino-style logger this package calls. */
export interface Logger {
  debug(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const silentLogger: Logger = { debug: () => {}, warn: () => {} };

export class RateLimitedError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(
      `Rate limit reached; retry in ${String(Math.ceil(retryAfterMs / 1000))} s`
    );
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(status: number, path: string, body: unknown, message?: string) {
    super(message ?? `HTTP ${String(status)} from ${path}`);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export interface RateLimit {
  /** Requests allowed per window by the upstream. */
  limit: number;
  windowMs: number;
  /** Requests that may go out back to back. */
  burst: number;
  /** Longest a request waits for a token before failing with RateLimitedError. */
  maxWaitMs?: number;
}

/**
 * Token bucket sized so that burst + refill over one window never exceeds the
 * upstream limit, whichever way the upstream aligns its window.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private blockedUntil = 0;
  private readonly refillPerMs: number;
  private readonly burst: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;

  constructor(rate: RateLimit, now: () => number = Date.now) {
    if (rate.burst >= rate.limit) {
      throw new RangeError('burst must be below limit');
    }
    this.burst = rate.burst;
    this.refillPerMs = (rate.limit - rate.burst) / rate.windowMs;
    this.maxWaitMs = rate.maxWaitMs ?? 5000;
    this.now = now;
    this.tokens = rate.burst;
    this.last = now();
  }

  /** Stops handing out tokens until the upstream says it is ready again. */
  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
    this.tokens = 0;
    // Refill from the end of the block, or the full burst lands right as it lifts.
    this.last = this.blockedUntil;
  }

  /** Milliseconds until a token is available; takes it when that is 0. */
  tryTake(): number {
    const now = this.now();
    if (now < this.blockedUntil) return this.blockedUntil - now;
    this.tokens = Math.min(
      this.burst,
      this.tokens + Math.max(0, now - this.last) * this.refillPerMs
    );
    this.last = Math.max(this.last, now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  async take(): Promise<void> {
    for (;;) {
      const wait = this.tryTake();
      if (wait === 0) return;
      if (wait > this.maxWaitMs) throw new RateLimitedError(wait);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export type QueryValue =
  string | number | boolean | undefined | null | readonly (string | number)[];

export interface FetchClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  rateLimit?: RateLimit;
  timeoutMs?: number;
  /** Extra attempts after a 5xx or a network failure. Timeouts are not retried. */
  retries?: number;
  logger?: Logger;
  fetch?: typeof fetch;
}

export interface FetchClient {
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, QueryValue> = {}
): URL {
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(
  header: string | null,
  now = Date.now()
): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createFetchClient(options: FetchClientOptions): FetchClient {
  const {
    baseUrl,
    headers = {},
    timeoutMs = 10_000,
    retries = 1,
    logger = silentLogger,
    fetch: doFetch = fetch
  } = options;
  const bucket = options.rateLimit
    ? new TokenBucket(options.rateLimit)
    : undefined;

  return {
    async get<T>(path: string, query?: Record<string, QueryValue>) {
      const url = buildUrl(baseUrl, path, query);
      // Headers can carry credentials; only the path and query are ever logged.
      const logPath = url.pathname + url.search;

      for (let attempt = 0; ; attempt++) {
        await bucket?.take();
        const started = Date.now();
        let response: Response;
        try {
          response = await doFetch(url, {
            headers: { accept: 'application/json', ...headers },
            signal: AbortSignal.timeout(timeoutMs)
          });
        } catch (error) {
          const timedOut =
            error instanceof DOMException && error.name === 'TimeoutError';
          logger.warn(
            { path: logPath, attempt, timedOut, err: String(error) },
            'upstream request failed'
          );
          if (!timedOut && attempt < retries) continue;
          throw new HttpError(
            timedOut ? 504 : 502,
            logPath,
            null,
            timedOut
              ? `Upstream did not answer within ${String(timeoutMs / 1000)} s`
              : 'Upstream could not be reached'
          );
        }

        logger.debug(
          {
            path: logPath,
            status: response.status,
            ms: Date.now() - started
          },
          'upstream'
        );

        if (response.status === 429) {
          const wait =
            parseRetryAfter(response.headers.get('retry-after')) ?? 60_000;
          bucket?.block(wait);
          await response.body?.cancel();
          throw new RateLimitedError(wait);
        }
        if (response.status >= 500 && attempt < retries) {
          await response.body?.cancel();
          continue;
        }
        const body = await readBody(response);
        if (!response.ok) throw new HttpError(response.status, logPath, body);
        return body as T;
      }
    }
  };
}
