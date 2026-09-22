import { describe, expect, it } from 'vitest';
import { createDateTime, type DateTimeOptions } from './index.js';

const nl = createDateTime({ locale: 'nl-NL', timeZone: 'Europe/Amsterdam' });
const us = createDateTime({ locale: 'en-US', timeZone: 'America/New_York' });

// ICU puts a narrow no-break space before AM/PM; compare it as a space.
const plain = (value: string): string => value.replace(/[\u202f\u00a0]/g, ' ');

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

const NOON_UTC = '2026-09-22T12:05:00Z';

describe('the host time zone does not matter', () => {
  it('runs under the zone the test script asked for', () => {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (process.env.TZ) expect(host).toBe(process.env.TZ);
  });

  it('formats the same instant the same way everywhere', () => {
    expect(nl.dateTime(NOON_UTC)).toBe('22-09-2026, 14:05');
    expect(plain(us.dateTime(NOON_UTC))).toBe('09/22/2026, 8:05 AM');
  });
});

describe('createDateTime', () => {
  it('requires a locale and a time zone', () => {
    const missingZone = { locale: 'nl-NL' } as unknown as DateTimeOptions;
    const missingLocale = {
      timeZone: 'Europe/Amsterdam'
    } as unknown as DateTimeOptions;
    expect(() => createDateTime(missingZone)).toThrow(TypeError);
    expect(() => createDateTime(missingLocale)).toThrow(TypeError);
    expect(() => createDateTime({ locale: 'nl-NL', timeZone: '' })).toThrow(
      TypeError
    );
  });

  it('rejects a time zone Intl does not know', () => {
    expect(() =>
      createDateTime({ locale: 'nl-NL', timeZone: 'Mars/Olympus_Mons' })
    ).toThrow(RangeError);
  });

  it('exposes the canonical locale and zone', () => {
    const dt = createDateTime({
      locale: 'nl-NL',
      timeZone: 'europe/amsterdam'
    });
    expect(dt.locale).toBe('nl-NL');
    expect(dt.timeZone).toBe('Europe/Amsterdam');
  });
});

describe('formatters, nl-NL in Europe/Amsterdam', () => {
  it('date', () => {
    expect(nl.date(NOON_UTC)).toBe('22-09-2026');
    expect(nl.date('2026-03-09T12:00:00Z')).toBe('09-03-2026');
  });

  it('time, 24-hour and padded', () => {
    expect(nl.time(NOON_UTC)).toBe('14:05');
    expect(nl.time('2026-01-15T08:05:00Z')).toBe('09:05');
  });

  it('dateTime', () => {
    expect(nl.dateTime('2026-01-15T08:05:00Z')).toBe('15-01-2026, 09:05');
  });

  it('dateLong, dateShort, dayMonth', () => {
    expect(nl.dateLong(NOON_UTC)).toBe('22 september 2026');
    expect(nl.dateShort(NOON_UTC)).toBe('22 sep 2026');
    expect(nl.dayMonth(NOON_UTC)).toBe('22 sep');
  });

  it('format takes any other Intl shape', () => {
    expect(nl.format(NOON_UTC, { weekday: 'long' })).toBe('dinsdag');
    expect(nl.format(NOON_UTC, { month: 'long', year: 'numeric' })).toBe(
      'september 2026'
    );
  });
});

describe('formatters, en-US in America/New_York', () => {
  it('date', () => {
    expect(us.date(NOON_UTC)).toBe('09/22/2026');
  });

  it('time, 12-hour', () => {
    expect(plain(us.time(NOON_UTC))).toBe('8:05 AM');
    expect(plain(us.time('2026-09-22T18:05:00Z'))).toBe('2:05 PM');
  });

  it('dateLong, dateShort, dayMonth', () => {
    expect(us.dateLong(NOON_UTC)).toBe('September 22, 2026');
    expect(us.dateShort(NOON_UTC)).toBe('Sep 22, 2026');
    expect(us.dayMonth(NOON_UTC)).toBe('Sep 22');
  });

  it('format', () => {
    expect(us.format(NOON_UTC, { weekday: 'long' })).toBe('Tuesday');
  });

  it('puts one instant on a different day than Amsterdam does', () => {
    const lateEvening = '2026-09-22T02:00:00Z';
    expect(nl.date(lateEvening)).toBe('22-09-2026');
    expect(us.date(lateEvening)).toBe('09/21/2026');
  });
});

describe('input', () => {
  it('accepts a Date, a timestamp and an ISO string with an offset', () => {
    const date = new Date(NOON_UTC);
    expect(nl.time(date)).toBe('14:05');
    expect(nl.time(date.getTime())).toBe('14:05');
    expect(nl.time('2026-09-22T14:05:00+02:00')).toBe('14:05');
    expect(nl.time('2026-09-22T08:05:00-04:00')).toBe('14:05');
  });

  it('reads an ISO string without an offset as wall-clock time in the zone', () => {
    expect(nl.time('2026-09-22T14:05')).toBe('14:05');
    expect(plain(us.time('2026-09-22T14:05'))).toBe('2:05 PM');
    expect(iso(nl.parse('2026-09-22T14:05'))).toBe('2026-09-22T12:05:00.000Z');
    expect(iso(us.parse('2026-09-22 14:05:30.250'))).toBe(
      '2026-09-22T18:05:30.250Z'
    );
  });

  it('keeps a date-only string on its calendar day in every zone', () => {
    // new Date('2026-09-22') is UTC midnight: 21 September in New York.
    expect(nl.date('2026-09-22')).toBe('22-09-2026');
    expect(us.date('2026-09-22')).toBe('09/22/2026');
    expect(iso(nl.parse('2026-09-22'))).toBe('2026-09-21T22:00:00.000Z');
  });

  it('returns an empty string for nothing', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(nl.date(empty)).toBe('');
      expect(nl.dateTime(empty)).toBe('');
      expect(nl.relative(empty)).toBe('');
      expect(nl.toZonedInput(empty)).toBe('');
      expect(nl.zonedParts(empty)).toBeNull();
      expect(nl.parse(empty)).toBeNull();
    }
  });

  it('returns an empty string for input that does not parse', () => {
    const invalid = [
      'gisteren',
      new Date('nonsense'),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      8.64e15 + 1,
      '2026-02-30',
      '2026-13-01',
      '2026-09-22T24:00',
      '2026-09-22T12:60'
    ];
    for (const value of invalid) {
      expect(nl.date(value)).toBe('');
      expect(nl.format(value, { weekday: 'long' })).toBe('');
      expect(nl.parse(value)).toBeNull();
    }
  });

  it('ignores untyped garbage instead of throwing', () => {
    const garbage = { toString: (): string => 'nope' } as unknown as string;
    expect(nl.date(garbage)).toBe('');
    expect(nl.fromZonedInput(garbage)).toBeNull();
  });
});

describe('DST in Europe/Amsterdam, formatting', () => {
  it('shifts by one hour in winter and two in summer', () => {
    expect(nl.time('2026-01-15T12:00:00Z')).toBe('13:00');
    expect(nl.time('2026-07-15T12:00:00Z')).toBe('14:00');
  });

  it('rolls over to the next day an hour earlier in summer', () => {
    expect(nl.dateTime('2026-01-15T23:30:00Z')).toBe('16-01-2026, 00:30');
    expect(nl.dateTime('2026-07-15T22:30:00Z')).toBe('16-07-2026, 00:30');
  });

  it('skips 02:00 on 29 March', () => {
    expect(nl.time('2026-03-29T00:59:00Z')).toBe('01:59');
    expect(nl.time('2026-03-29T01:00:00Z')).toBe('03:00');
  });

  it('shows 02:30 twice on 25 October', () => {
    expect(nl.time('2026-10-25T00:30:00Z')).toBe('02:30');
    expect(nl.time('2026-10-25T01:30:00Z')).toBe('02:30');
  });
});

describe('zonedParts', () => {
  it('returns the wall-clock fields in the zone', () => {
    expect(nl.zonedParts('2026-12-31T23:30:15Z')).toEqual({
      year: 2027,
      month: 1,
      day: 1,
      hour: 0,
      minute: 30,
      second: 15
    });
    expect(us.zonedParts('2026-12-31T23:30:15Z')).toEqual({
      year: 2026,
      month: 12,
      day: 31,
      hour: 18,
      minute: 30,
      second: 15
    });
  });
});

describe('toZonedInput', () => {
  it('writes YYYY-MM-DDTHH:mm in the zone', () => {
    expect(nl.toZonedInput(NOON_UTC)).toBe('2026-09-22T14:05');
    expect(us.toZonedInput(NOON_UTC)).toBe('2026-09-22T08:05');
    expect(nl.toZonedInput('2026-01-15T12:00:00Z')).toBe('2026-01-15T13:00');
  });

  it('jumps from 01:59 to 03:00 on 29 March', () => {
    expect(nl.toZonedInput('2026-03-29T00:59:00Z')).toBe('2026-03-29T01:59');
    expect(nl.toZonedInput('2026-03-29T01:00:00Z')).toBe('2026-03-29T03:00');
  });

  it('writes 02:30 for both instants on 25 October', () => {
    expect(nl.toZonedInput('2026-10-25T00:30:00Z')).toBe('2026-10-25T02:30');
    expect(nl.toZonedInput('2026-10-25T01:30:00Z')).toBe('2026-10-25T02:30');
  });
});

describe('fromZonedInput', () => {
  it('reads wall-clock time in the zone', () => {
    expect(iso(nl.fromZonedInput('2026-01-15T13:00'))).toBe(
      '2026-01-15T12:00:00.000Z'
    );
    expect(iso(nl.fromZonedInput('2026-07-15T14:00'))).toBe(
      '2026-07-15T12:00:00.000Z'
    );
    expect(iso(us.fromZonedInput('2026-07-15T08:00'))).toBe(
      '2026-07-15T12:00:00.000Z'
    );
  });

  it('accepts seconds, which datetime-local sends with a step below 60', () => {
    expect(iso(nl.fromZonedInput('2026-09-22T14:05:30'))).toBe(
      '2026-09-22T12:05:30.000Z'
    );
  });

  it('moves a time skipped on 29 March forward by the hour it lost', () => {
    expect(iso(nl.fromZonedInput('2026-03-29T01:59'))).toBe(
      '2026-03-29T00:59:00.000Z'
    );
    // 02:00 and 02:30 never happen; they become 03:00 and 03:30.
    expect(iso(nl.fromZonedInput('2026-03-29T02:00'))).toBe(
      '2026-03-29T01:00:00.000Z'
    );
    expect(iso(nl.fromZonedInput('2026-03-29T02:30'))).toBe(
      '2026-03-29T01:30:00.000Z'
    );
    expect(iso(nl.fromZonedInput('2026-03-29T03:00'))).toBe(
      '2026-03-29T01:00:00.000Z'
    );
    expect(nl.toZonedInput(nl.fromZonedInput('2026-03-29T02:30'))).toBe(
      '2026-03-29T03:30'
    );
  });

  it('takes the earlier, summer-time instant for 02:30 on 25 October', () => {
    expect(iso(nl.fromZonedInput('2026-10-25T01:59'))).toBe(
      '2026-10-24T23:59:00.000Z'
    );
    expect(iso(nl.fromZonedInput('2026-10-25T02:30'))).toBe(
      '2026-10-25T00:30:00.000Z'
    );
    expect(iso(nl.fromZonedInput('2026-10-25T03:00'))).toBe(
      '2026-10-25T02:00:00.000Z'
    );
  });

  it('handles the New York switches the same way', () => {
    // 8 March 2026: 02:00 EST jumps to 03:00 EDT.
    expect(iso(us.fromZonedInput('2026-03-08T02:30'))).toBe(
      '2026-03-08T07:30:00.000Z'
    );
    // 1 November 2026: 01:30 happens in EDT and again in EST.
    expect(iso(us.fromZonedInput('2026-11-01T01:30'))).toBe(
      '2026-11-01T05:30:00.000Z'
    );
  });

  it('round-trips every quarter hour across both switch days', () => {
    for (const day of ['2026-03-29', '2026-10-25']) {
      for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
        const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
        const mm = String(minutes % 60).padStart(2, '0');
        const value = `${day}T${hh}:${mm}`;
        if (day === '2026-03-29' && hh === '02') continue;
        expect(nl.toZonedInput(nl.fromZonedInput(value))).toBe(value);
      }
    }
  });

  it('returns null for anything that is not a real date and time', () => {
    const invalid = [
      '',
      '2026-09-22',
      '2026-09-22 14:05',
      '2026-09-22T14:05Z',
      '2026-02-29T10:00',
      '2026-04-31T10:00',
      '2026-09-22T25:00',
      '22-09-2026T14:05'
    ];
    for (const value of invalid) expect(nl.fromZonedInput(value)).toBeNull();
    expect(nl.fromZonedInput('2028-02-29T10:00')).not.toBeNull();
  });
});

describe('relative', () => {
  const now = new Date('2026-09-22T12:00:00Z');
  const at = (seconds: number): Date =>
    new Date(now.getTime() + seconds * 1000);

  it('picks the largest unit that fits', () => {
    expect(nl.relative(at(-3 * 3600), { now })).toBe('3 uur geleden');
    expect(nl.relative(at(2 * 86_400), { now })).toBe('over 2 dagen');
    expect(nl.relative(at(-14 * 86_400), { now })).toBe('2 weken geleden');
    expect(nl.relative(at(-45 * 86_400), { now })).toBe('1 maand geleden');
    expect(nl.relative(at(-400 * 86_400), { now })).toBe('1 jaar geleden');
  });

  it('truncates instead of rounding up', () => {
    expect(nl.relative(at(-59), { now })).toBe('59 seconden geleden');
    expect(nl.relative(at(-3599), { now })).toBe('59 minuten geleden');
    expect(nl.relative(at(-86_399), { now })).toBe('23 uur geleden');
  });

  it('reads under a second as the past', () => {
    expect(nl.relative(now, { now })).toBe('0 seconden geleden');
    expect(nl.relative(at(0.4), { now, numeric: 'auto' })).toBe('nu');
  });

  it('numeric auto uses words where the locale has them', () => {
    expect(nl.relative(at(-86_400), { now, numeric: 'auto' })).toBe('gisteren');
    expect(us.relative(at(86_400), { now, numeric: 'auto' })).toBe('tomorrow');
  });

  it('speaks the locale and style', () => {
    expect(us.relative(at(-3 * 3600), { now })).toBe('3 hours ago');
    expect(us.relative(at(2 * 86_400), { now })).toBe('in 2 days');
    expect(us.relative(at(-3 * 3600), { now, style: 'short' })).toBe(
      '3 hr. ago'
    );
  });

  it('accepts now as a string or timestamp', () => {
    expect(nl.relative('2026-09-22T09:00:00Z', { now: now.getTime() })).toBe(
      '3 uur geleden'
    );
    expect(nl.relative(at(-60), { now: '2026-09-22T12:00:00Z' })).toBe(
      '1 minuut geleden'
    );
  });

  it('returns an empty string when either side does not parse', () => {
    expect(nl.relative('gisteren', { now })).toBe('');
    expect(nl.relative(now, { now: 'straks' })).toBe('');
  });

  it('measures from the current time by default', () => {
    expect(nl.relative(new Date(Date.now() - 5 * 60_000))).toBe(
      '5 minuten geleden'
    );
  });
});
