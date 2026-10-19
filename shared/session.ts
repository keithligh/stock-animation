import type { Market } from './symbols';

const CLOSE_MINUTES = 16 * 60;

const TIME_ZONE: Record<Market, string> = {
  HK: 'Asia/Hong_Kong',
  US: 'America/New_York',
};

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

interface ZonedNow extends CivilDate {
  minutes: number;
}

/** Last completed cash session, `YYYY-MM-DD`, in the market's timezone. */
export function lastCompletedSession(market: Market, now: Date): string {
  const zone = TIME_ZONE[market];
  const zoned = zonedParts(now, zone);
  const today: CivilDate = { year: zoned.year, month: zoned.month, day: zoned.day };
  const afterClose = isWeekday(today) && zoned.minutes >= CLOSE_MINUTES;
  const session = afterClose ? today : previousWeekday(today);
  return formatDate(session);
}

/** `d` is accepted when it is the expected session, plus or minus one calendar day. */
export function isAcceptableSessionDate(market: Market, sessionDate: string, now: Date): boolean {
  if (!isIsoDate(sessionDate)) return false;
  const expected = lastCompletedSession(market, now);
  return Math.abs(dateOrdinal(sessionDate) - dateOrdinal(expected)) <= 1;
}

/**
 * Seconds until the next 16:00 local close, plus 30 minutes.
 * This is the edge `max-age` for a successful chart response.
 */
export function cacheMaxAgeSeconds(market: Market, now: Date): number {
  const zone = TIME_ZONE[market];
  const zoned = zonedParts(now, zone);
  const today: CivilDate = { year: zoned.year, month: zoned.month, day: zoned.day };
  const beforeClose = isWeekday(today) && zoned.minutes < CLOSE_MINUTES;
  const closeDay = beforeClose ? today : nextWeekday(today);
  const closeUtc = zonedCivilToUtc(closeDay.year, closeDay.month, closeDay.day, 16, 30, zone);
  const seconds = Math.ceil((closeUtc.getTime() - now.getTime()) / 1000);
  return Math.max(60, seconds);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/** Exchange-local calendar date for a Yahoo daily bar timestamp. */
export function timestampToExchangeDate(unixSeconds: number, timeZone: string): string {
  const parts = zonedParts(new Date(unixSeconds * 1000), timeZone);
  return formatDate(parts);
}

function zonedParts(now: Date, timeZone: string): ZonedNow {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    minutes: hour * 60 + Number(bag.minute),
  };
}

function zonedCivilToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = offsetMs(guess, timeZone);
  const adjusted = new Date(guess.getTime() - offset);
  const offsetAtAdjusted = offsetMs(adjusted, timeZone);
  if (offsetAtAdjusted === offset) return adjusted;
  return new Date(guess.getTime() - offsetAtAdjusted);
}

function offsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    Math.floor(parts.minutes / 60),
    parts.minutes % 60,
    0,
  );
  return asUtc - instant.getTime();
}

function previousWeekday(date: CivilDate): CivilDate {
  let cursor = shiftDate(date, -1);
  while (!isWeekday(cursor)) cursor = shiftDate(cursor, -1);
  return cursor;
}

function nextWeekday(date: CivilDate): CivilDate {
  let cursor = shiftDate(date, 1);
  while (!isWeekday(cursor)) cursor = shiftDate(cursor, 1);
  return cursor;
}

function shiftDate(date: CivilDate, days: number): CivilDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function isWeekday(date: CivilDate): boolean {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day !== 0 && day !== 6;
}

function formatDate(date: CivilDate): string {
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

function dateOrdinal(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / 86_400_000);
}
