/**
 * Wall-clock arithmetic for an IANA time zone, on top of Intl alone. Nothing
 * here reads the host's time zone, so the same input gives the same answer
 * on a server in UTC and a browser in Tokyo.
 */

/** A moment as a clock on the wall in the configured zone shows it. */
export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  /** 0-23 */
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock fields plus milliseconds, as parsed from a string. */
export interface WallClock extends ZonedParts {
  millisecond: number;
}

const DAY_MS = 86_400_000;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23'
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock fields of an epoch-millisecond instant in `timeZone`. */
export function partsAt(ms: number, timeZone: string): ZonedParts {
  const fields: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year ?? 0,
    month: fields.month ?? 1,
    day: fields.day ?? 1,
    hour: fields.hour ?? 0,
    minute: fields.minute ?? 0,
    second: fields.second ?? 0
  };
}

/**
 * Wall-clock fields read as if they were UTC. `Date.UTC` maps years 0-99 to
 * the 1900s, so the year is set separately.
 */
function wallAsUtc(parts: ZonedParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}

/** UTC offset of `timeZone` at an instant, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const wholeSecond = ms - (((ms % 1000) + 1000) % 1000);
  return wallAsUtc(partsAt(ms, timeZone)) - wholeSecond;
}

/** True when the fields name a real calendar day and time of day. */
export function isValidWallClock(wall: WallClock): boolean {
  if (wall.month < 1 || wall.month > 12) return false;
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  return date.getUTCDate() === wall.day;
}

/**
 * The instant at which a clock in `timeZone` shows `wall`.
 *
 * Around a DST switch a wall-clock time can exist twice or not at all. This
 * resolves both the way Temporal's `disambiguation: 'compatible'` does:
 *
 * - repeated (autumn, 02:30 happens twice): the earlier of the two instants,
 *   still on summer time;
 * - skipped (spring, 02:30 never happens): moved forward by the length of the
 *   gap, so 02:30 becomes 03:30 — what a clock that was set the night before
 *   would show.
 *
 * Assumes at most one offset change within a day of `wall`, which holds for
 * every zone in the tz database.
 */
export function wallClockToInstant(wall: WallClock, timeZone: string): number {
  const target = wallAsUtc(wall);
  const offsetBefore = offsetAt(target - DAY_MS, timeZone);
  const offsetAfter = offsetAt(target + DAY_MS, timeZone);

  const matches = [target - offsetBefore, target - offsetAfter]
    .filter((ms) => wallAsUtc(partsAt(ms, timeZone)) === target)
    .sort((a, b) => a - b);

  // No match means a gap. The offset from before the switch is the smaller
  // one, so subtracting it lands past the gap by exactly its length.
  const instant = matches[0] ?? target - offsetBefore;
  return instant + wall.millisecond;
}

const pad = (value: number, length = 2): string =>
  String(value).padStart(length, '0');

/** `YYYY-MM-DDTHH:mm`, the value `<input type="datetime-local">` takes. */
export function formatWallClock(parts: ZonedParts): string {
  const date = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
  return `${date}T${pad(parts.hour)}:${pad(parts.minute)}`;
}
