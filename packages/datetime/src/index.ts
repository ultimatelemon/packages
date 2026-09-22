import { type DateInput, parseZonedInput, toInstant } from './input.js';
import { type RelativeOptions, relativeParts } from './relative.js';
import { formatWallClock, partsAt, type ZonedParts } from './zoned.js';

export type { DateInput } from './input.js';
export type { RelativeOptions } from './relative.js';
export type { ZonedParts } from './zoned.js';

export interface DateTimeOptions {
  /** BCP 47 language tag: `'nl-NL'`, `'en-US'`, `'de-DE'`. */
  locale: string;
  /** IANA time zone: `'Europe/Amsterdam'`, `'America/New_York'`, `'UTC'`. */
  timeZone: string;
}

/** `Intl.DateTimeFormatOptions` without `timeZone`, which the instance owns. */
export type FormatOptions = Omit<Intl.DateTimeFormatOptions, 'timeZone'>;

export interface DateTime {
  /** The locale as Intl resolved it. */
  readonly locale: string;
  /** The time zone in its canonical spelling. */
  readonly timeZone: string;

  /** Numeric date: `22-09-2026` (nl-NL), `09/22/2026` (en-US). */
  date(input: DateInput): string;
  /** Time of day: `14:05` (nl-NL), `2:05 PM` (en-US). */
  time(input: DateInput): string;
  /** Numeric date and time: `22-09-2026, 14:05`. */
  dateTime(input: DateInput): string;
  /** Written-out month: `22 september 2026`, `September 22, 2026`. */
  dateLong(input: DateInput): string;
  /** Abbreviated month: `22 sep 2026`, `Sep 22, 2026`. */
  dateShort(input: DateInput): string;
  /** Day and abbreviated month, no year: `22 sep`, `Sep 22`. */
  dayMonth(input: DateInput): string;
  /** `3 uur geleden`, `over 2 dagen`, `3 hours ago`. */
  relative(input: DateInput, options?: RelativeOptions): string;
  /** Any other shape, in this instance's locale and time zone. */
  format(input: DateInput, options: FormatOptions): string;

  /** The input as a `Date`, or `null` when it does not parse. */
  parse(input: DateInput): Date | null;
  /** The wall-clock fields in this time zone, or `null`. */
  zonedParts(input: DateInput): ZonedParts | null;
  /** Value for `<input type="datetime-local">`: `2026-09-22T14:05`. */
  toZonedInput(input: DateInput): string;
  /**
   * Reads a `datetime-local` value as wall-clock time in this zone. Returns
   * `null` for anything that is not a real date and time.
   */
  fromZonedInput(value: string): Date | null;
}

const DATE: FormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
};
const TIME: FormatOptions = { timeStyle: 'short' };
const DATE_LONG: FormatOptions = {
  day: 'numeric',
  month: 'long',
  year: 'numeric'
};
const DATE_SHORT: FormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric'
};
const DAY_MONTH: FormatOptions = { day: 'numeric', month: 'short' };

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

function dateFormat(
  locale: string,
  timeZone: string,
  options: FormatOptions
): Intl.DateTimeFormat {
  const key = `${locale}\u0000${timeZone}\u0000${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    dateFormats.set(key, format);
  }
  return format;
}

function relativeFormat(
  locale: string,
  style: Intl.RelativeTimeFormatStyle,
  numeric: Intl.RelativeTimeFormatNumeric
): Intl.RelativeTimeFormat {
  const key = `${locale}\u0000${style}\u0000${numeric}`;
  let format = relativeFormats.get(key);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { style, numeric });
    relativeFormats.set(key, format);
  }
  return format;
}

/**
 * Whether the locale writes the hour of a short time with two digits (09:05)
 * or one (9:05 AM). `timeStyle` knows, but cannot be combined with `day`,
 * `month` and `year`, so `dateTime` asks once and reuses the answer.
 */
function hourStyle(locale: string): '2-digit' | 'numeric' {
  const hour = dateFormat(locale, 'UTC', TIME)
    .formatToParts(Date.UTC(2000, 0, 1, 9, 5))
    .find((part) => part.type === 'hour');
  return hour && hour.value.length === 2 ? '2-digit' : 'numeric';
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(
      `createDateTime: \`${name}\` is required, e.g. ${
        name === 'locale' ? "'nl-NL'" : "'Europe/Amsterdam'"
      }.`
    );
  }
  return value;
}

/**
 * A set of formatters bound to one locale and one time zone.
 *
 * Both are required. Leaving the zone to the runtime is what makes a server
 * in UTC and a browser in Amsterdam render different HTML for the same date.
 * Throws a `RangeError` for a locale or time zone Intl does not know.
 */
export function createDateTime(options: DateTimeOptions): DateTime {
  const resolved = new Intl.DateTimeFormat(
    requireString(options.locale, 'locale'),
    { timeZone: requireString(options.timeZone, 'timeZone') }
  ).resolvedOptions();
  const locale = resolved.locale;
  const timeZone = resolved.timeZone;

  const dateTimeShape: FormatOptions = {
    ...DATE,
    hour: hourStyle(locale),
    minute: '2-digit'
  };

  const format = (input: DateInput, shape: FormatOptions): string => {
    const ms = toInstant(input, timeZone);
    return ms === null ? '' : dateFormat(locale, timeZone, shape).format(ms);
  };

  return {
    locale,
    timeZone,

    date: (input) => format(input, DATE),
    time: (input) => format(input, TIME),
    dateTime: (input) => format(input, dateTimeShape),
    dateLong: (input) => format(input, DATE_LONG),
    dateShort: (input) => format(input, DATE_SHORT),
    dayMonth: (input) => format(input, DAY_MONTH),
    format,

    relative(input, relativeOptions = {}): string {
      const ms = toInstant(input, timeZone);
      const now =
        relativeOptions.now === undefined
          ? Date.now()
          : toInstant(relativeOptions.now, timeZone);
      if (ms === null || now === null) return '';
      const [value, unit] = relativeParts((ms - now) / 1000);
      return relativeFormat(
        locale,
        relativeOptions.style ?? 'long',
        relativeOptions.numeric ?? 'always'
      ).format(value, unit);
    },

    parse(input): Date | null {
      const ms = toInstant(input, timeZone);
      return ms === null ? null : new Date(ms);
    },

    zonedParts(input): ZonedParts | null {
      const ms = toInstant(input, timeZone);
      return ms === null ? null : partsAt(ms, timeZone);
    },

    toZonedInput(input): string {
      const ms = toInstant(input, timeZone);
      return ms === null ? '' : formatWallClock(partsAt(ms, timeZone));
    },

    fromZonedInput: (value) => parseZonedInput(value, timeZone)
  };
}
