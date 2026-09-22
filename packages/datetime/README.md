# @ultimatelemon-eu/datetime

Date and time formatting for any locale and any time zone, with the same
output on the server and in the browser. Built on `Intl` alone, no
dependencies.

```bash
npm install @ultimatelemon-eu/datetime
```

```ts
// src/lib/datetime.ts
import { createDateTime } from '@ultimatelemon-eu/datetime';

export const dt = createDateTime({
  locale: 'nl-NL',
  timeZone: 'Europe/Amsterdam'
});
```

```ts
dt.date(order.createdAt); // 22-09-2026
dt.time(order.createdAt); // 14:05
dt.dateTime(order.createdAt); // 22-09-2026, 14:05
dt.dateLong(order.createdAt); // 22 september 2026
dt.dateShort(order.createdAt); // 22 sep 2026
dt.dayMonth(order.createdAt); // 22 sep
dt.relative(order.createdAt); // 3 uur geleden
dt.format(order.createdAt, { weekday: 'long' }); // dinsdag
```

The same calls with `{ locale: 'en-US', timeZone: 'America/New_York' }` give
`09/22/2026`, `8:05 AM`, `September 22, 2026`, `3 hours ago`. The shapes come
from the locale; nothing is hard-coded for one language.

## API

`createDateTime({ locale, timeZone })` returns:

| Member                    | Returns                     | nl-NL, Europe/Amsterdam |
| ------------------------- | --------------------------- | ----------------------- |
| `date(input)`             | `string`                    | `22-09-2026`            |
| `time(input)`             | `string`                    | `14:05`                 |
| `dateTime(input)`         | `string`                    | `22-09-2026, 14:05`     |
| `dateLong(input)`         | `string`                    | `22 september 2026`     |
| `dateShort(input)`        | `string`                    | `22 sep 2026`           |
| `dayMonth(input)`         | `string`                    | `22 sep`                |
| `relative(input, opts?)`  | `string`                    | `3 uur geleden`         |
| `format(input, intlOpts)` | `string`                    | anything Intl can do    |
| `parse(input)`            | `Date \| null`              |                         |
| `zonedParts(input)`       | `ZonedParts \| null`        | `{ year, month, ... }`  |
| `toZonedInput(input)`     | `string`                    | `2026-09-22T14:05`      |
| `fromZonedInput(value)`   | `Date \| null`              |                         |
| `locale`, `timeZone`      | the resolved, canonical tag | `nl-NL`                 |

`input` is a `Date`, a timestamp, a string, `null` or `undefined`. Anything
empty or unparseable formats as `''`, so an optional column needs no guard.

`createDateTime` throws a `TypeError` when `locale` or `timeZone` is missing
and a `RangeError` when Intl does not know one of them. Create it once per
module; the underlying `Intl` formatters are cached either way.

### Strings

- With `Z` or an offset (`2026-09-22T12:05:00Z`): that exact instant.
- ISO without an offset (`2026-09-22T14:05`, `2026-09-22`): wall-clock time
  in the configured zone. This differs from `new Date()` on purpose: it reads
  the first in the host's zone and the second as UTC midnight, which is the
  previous day west of Greenwich. A `date` column passed as `'2026-09-22'`
  stays on 22 September everywhere.
- Anything else goes to `Date.parse`. Avoid it; its result can depend on the
  host.

A `Date` for a `date` column that the ORM built at UTC midnight is an instant
like any other, and shows as the previous day in New York. Pass the
`YYYY-MM-DD` string, or a separate instance with `timeZone: 'UTC'`.

### relative

```ts
dt.relative(comment.createdAt, { now, style: 'short', numeric: 'auto' });
```

| Option    | Default      | Does                                              |
| --------- | ------------ | ------------------------------------------------- |
| `now`     | `Date.now()` | Moment to measure from; pass one value per render |
| `style`   | `'long'`     | `'long'`, `'short'` or `'narrow'`                 |
| `numeric` | `'always'`   | `'auto'` gives `gisteren`, `morgen`, `nu`         |

It picks the largest unit that fits and truncates: 59 seconds is `59 seconden
geleden`, never `1 minuut geleden`. Months are 30 days and years 365.

### datetime-local inputs

`<input type="datetime-local">` holds a wall-clock time with no zone. The
browser does not add one, and `new Date(value)` on the server reads it in the
server's zone, which in a container is UTC. Convert both ways explicitly:

```tsx
// server: fill the form
<input type="datetime-local" defaultValue={dt.toZonedInput(ad.startsAt)} />;

// server action: read it back
const startsAt = dt.fromZonedInput(String(formData.get('startsAt')));
if (!startsAt) return { error: 'Invalid date' };
```

`fromZonedInput` accepts `YYYY-MM-DDTHH:mm` with optional seconds and returns
`null` for anything else, including days that do not exist (`2026-02-29`).

Twice a year a wall-clock time is ambiguous. It is resolved the way
Temporal's `disambiguation: 'compatible'` does:

- **Skipped** (spring forward, Europe/Amsterdam 29 March 2026: 02:00 jumps to
  03:00): moved forward by the gap, so `02:30` becomes 03:30 summer time.
- **Repeated** (fall back, 25 October 2026: 02:00–03:00 happens twice): the
  earlier of the two, still summer time. `02:30` is 00:30 UTC, not 01:30 UTC.

## Next.js

A server component and a client component can share the instance; the output
is the same in both.

```tsx
// app/orders/page.tsx (server component)
import { dt } from '@/lib/datetime';

export default async function Page(): Promise<React.JSX.Element> {
  const orders = await getOrders();
  const now = new Date();
  return (
    <ul>
      {orders.map((order) => (
        <li key={order.id}>
          <time dateTime={order.createdAt.toISOString()}>
            {dt.dateTime(order.createdAt)}
          </time>{' '}
          ({dt.relative(order.createdAt, { now })})
        </li>
      ))}
    </ul>
  );
}
```

```tsx
// components/LastSaved.tsx (client component)
'use client';

import { dt } from '@/lib/datetime';

interface LastSavedProps {
  savedAt: string;
}

export function LastSaved({ savedAt }: LastSavedProps): React.JSX.Element {
  return <p>Opgeslagen om {dt.time(savedAt)}</p>;
}
```

Dates cross the server/client boundary as ISO strings; every formatter takes
them directly.

## Why `timeZone` is required

`toLocaleString('nl-NL')` without a zone uses the zone of whatever runs it.
The server renders in UTC, the browser hydrates in Europe/Amsterdam, the text
differs by an hour or a day, and React reports a hydration mismatch — or, in a
server-only page, every date is silently an hour or two off. A default zone
would bring the same bug back for everyone outside it, so there is none.

Tests in this package run under `TZ=UTC`, `TZ=Asia/Tokyo` and
`TZ=America/Los_Angeles` and expect identical output.

## `relative` and cached HTML

`relative` compares against a moment in time, so its output is only true when
it is rendered. In a statically generated or cached page, "3 minuten geleden"
stays on screen for as long as the cache lives. Render it per request, or
show an absolute date there instead. In a client component, compute it after
mount (in an effect): during hydration the server's "now" and the browser's
differ, and so does the text.
