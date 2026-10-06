# @ultimatelemon-eu/fetch-client

`fetch` for APIs with a rate limit. It keeps you under the limit instead of
finding out through 429s, waits when the API says so, gives up after a
timeout, retries once when the upstream hiccups, and throws errors you can
tell apart. No dependencies; runs anywhere `fetch` does.

```bash
npm install @ultimatelemon-eu/fetch-client
```

```ts
import { createFetchClient } from '@ultimatelemon-eu/fetch-client';

const ns = createFetchClient({
  baseUrl: 'https://gateway.apiportal.ns.nl',
  headers: { 'Ocp-Apim-Subscription-Key': process.env.NS_API_KEY ?? '' },
  // NS: 300 requests per 5 minutes per key.
  rateLimit: { limit: 300, windowMs: 300_000, burst: 40 }
});

const body = await ns.get<{ payload: unknown[] }>('/nsapp-stations/v3', {
  countryCodes: ['NL', 'BE'], // arrays repeat the parameter
  q: undefined // undefined and null are left out
});
```

## Options

| Option      | Default        | Does                                            |
| ----------- | -------------- | ----------------------------------------------- |
| `baseUrl`   | required       | Prefix for every path                           |
| `headers`   | `{}`           | Sent with every request; never logged           |
| `rateLimit` | none           | Token bucket, see below                         |
| `timeoutMs` | `10_000`       | Per attempt                                     |
| `retries`   | `1`            | Extra attempts after a 5xx or a network failure |
| `logger`    | silent         | Anything with `debug` and `warn`, such as pino  |
| `fetch`     | global `fetch` | For tests, or a runtime with its own            |

## Rate limiting

`rateLimit: { limit, windowMs, burst, maxWaitMs? }` sets up a token bucket that
starts with `burst` tokens and refills at `(limit - burst) / windowMs`. Burst
plus refill over any window never exceeds `limit`, however the upstream
aligns its window, so a fixed-window API never sees request 301.

When the bucket is empty a request waits for the next token, up to
`maxWaitMs` (default 5 s). Beyond that it throws `RateLimitedError` at once
rather than hanging a caller for minutes.

On a 429 the client reads `Retry-After` (seconds or an HTTP date, 60 s when
absent), blocks the bucket until then and throws `RateLimitedError`. Refill
starts when the block ends, so the full burst does not land on the API the
moment it lets you back in.

The bucket lives in the process: with several replicas, divide `limit` by the
replica count.

## Errors

| Error              | When                                                  | Fields                   |
| ------------------ | ----------------------------------------------------- | ------------------------ |
| `RateLimitedError` | Bucket empty past `maxWaitMs`, or a 429               | `retryAfterMs`           |
| `HttpError`        | Any other non-2xx, a timeout (504), unreachable (502) | `status`, `path`, `body` |

Timeouts are not retried: a request that took 10 s once will likely take 10 s
again, and the caller is already waiting.

## Logging

Each response is logged at `debug` with path, query, status and duration;
failed attempts at `warn`. Headers are never logged, so a key in a header
stays out of the logs. Keep credentials out of the query string.

## Scope

Only `get`, which is what read-only API wrappers need. Writes would need a
different retry policy (a POST is not safe to repeat), so they are left out
until a project needs them.
