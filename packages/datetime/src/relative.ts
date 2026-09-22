export interface RelativeOptions {
  /**
   * The moment to measure from. Defaults to the current time. Pass one
   * shared value when rendering a list, so every row agrees on "now".
   */
  now?: Date | string | number;
  /** `'long'` (3 uur geleden), `'short'` or `'narrow'`. Default `'long'`. */
  style?: Intl.RelativeTimeFormatStyle;
  /**
   * `'always'` (1 dag geleden) or `'auto'` (gisteren, nu). Default
   * `'always'`.
   */
  numeric?: Intl.RelativeTimeFormatNumeric;
}

type Unit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute';

// Months and years are fixed lengths, not calendar months: close enough for
// "about how long ago", and independent of any time zone.
const UNITS: readonly (readonly [Unit, number])[] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60]
];

/**
 * The largest unit that fits at least once, truncated rather than rounded:
 * 59 seconds is never "1 minute ago", 23 hours never "1 day ago".
 */
export function relativeParts(
  seconds: number
): [number, Intl.RelativeTimeFormatUnit] {
  const size = Math.abs(seconds);
  for (const [unit, length] of UNITS) {
    if (size >= length) return [Math.trunc(seconds / length), unit];
  }
  // Under a second either way reads as the past ("0 seconds ago", or "now"
  // with numeric 'auto') rather than "in 0 seconds".
  return [Math.trunc(seconds) || -0, 'second'];
}
