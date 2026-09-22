import {
  isValidWallClock,
  type WallClock,
  wallClockToInstant
} from './zoned.js';

/**
 * Anything a formatter accepts. `null`, `undefined`, `''` and anything that
 * does not parse all format as `''`, so a missing value needs no guard.
 */
export type DateInput = Date | string | number | null | undefined;

// An ISO date or date-time without `Z` or an offset: `2026-09-22`,
// `2026-09-22T14:05`, `2026-09-22 14:05:30.250`.
const LOCAL_ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/;

const ZONED_INPUT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

function wallFromMatch(match: RegExpExecArray): WallClock {
  const field = (index: number): number => Number(match[index] ?? 0);
  return {
    year: field(1),
    month: field(2),
    day: field(3),
    hour: field(4),
    minute: field(5),
    second: field(6),
    millisecond: Number((match[7] ?? '0').padEnd(3, '0'))
  };
}

function fromWall(match: RegExpExecArray, timeZone: string): number | null {
  const wall = wallFromMatch(match);
  return isValidWallClock(wall) ? wallClockToInstant(wall, timeZone) : null;
}

/**
 * Epoch milliseconds for an input, or `null` when there is nothing usable.
 *
 * An ISO string without an offset is wall-clock time in `timeZone`, not in
 * the host's zone (`new Date('2026-09-22T14:05')`) and not in UTC
 * (`new Date('2026-09-22')`). Both built-in readings depend on where the
 * code runs or shift a calendar day across the date line.
 */
export function toInstant(input: DateInput, timeZone: string): number | null {
  if (input === null || input === undefined) return null;

  if (typeof input === 'number') {
    return Number.isNaN(new Date(input).getTime()) ? null : input;
  }

  if (input instanceof Date) {
    const ms = input.getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  // Guards callers without types, who can pass anything.
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (value === '') return null;

  const local = LOCAL_ISO.exec(value);
  if (local) return fromWall(local, timeZone);

  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Parses the value of `<input type="datetime-local">` (`YYYY-MM-DDTHH:mm`,
 * optionally with seconds) as wall-clock time in `timeZone`.
 */
export function parseZonedInput(value: string, timeZone: string): Date | null {
  if (typeof value !== 'string') return null;
  const match = ZONED_INPUT.exec(value.trim());
  if (!match) return null;
  const ms = fromWall(match, timeZone);
  return ms === null ? null : new Date(ms);
}
