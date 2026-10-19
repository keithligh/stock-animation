import { describe, expect, it } from 'vitest';
import { cacheMaxAgeSeconds, isAcceptableSessionDate, lastCompletedSession } from '../shared/session';

const MONDAY_MORNING_UTC = new Date('2026-10-19T09:54:00Z');

describe('session dates', () => {
  it('uses the HK close on a Monday evening in Hong Kong', () => {
    expect(lastCompletedSession('HK', MONDAY_MORNING_UTC)).toBe('2026-10-19');
    expect(isAcceptableSessionDate('HK', '2026-10-19', MONDAY_MORNING_UTC)).toBe(true);
    expect(isAcceptableSessionDate('HK', '2026-10-18', MONDAY_MORNING_UTC)).toBe(true);
    expect(isAcceptableSessionDate('HK', '2026-10-20', MONDAY_MORNING_UTC)).toBe(true);
    expect(isAcceptableSessionDate('HK', '2026-10-17', MONDAY_MORNING_UTC)).toBe(false);
  });

  it('uses the previous US session before the New York open', () => {
    expect(lastCompletedSession('US', MONDAY_MORNING_UTC)).toBe('2026-10-16');
    expect(isAcceptableSessionDate('US', '2026-10-16', MONDAY_MORNING_UTC)).toBe(true);
    expect(isAcceptableSessionDate('US', '2026-10-15', MONDAY_MORNING_UTC)).toBe(true);
    expect(isAcceptableSessionDate('US', '2026-10-17', MONDAY_MORNING_UTC)).toBe(true);
    expect(isAcceptableSessionDate('US', '2026-10-14', MONDAY_MORNING_UTC)).toBe(false);
    expect(isAcceptableSessionDate('US', '2026-10-19', MONDAY_MORNING_UTC)).toBe(false);
  });

  it('steps back over the weekend', () => {
    const sunday = new Date('2026-10-18T12:00:00Z');
    expect(lastCompletedSession('HK', sunday)).toBe('2026-10-16');
    expect(lastCompletedSession('US', sunday)).toBe('2026-10-16');
  });

  it('follows US eastern time across standard time', () => {
    expect(lastCompletedSession('US', new Date('2026-01-05T14:00:00Z'))).toBe('2026-01-02');
    expect(lastCompletedSession('US', new Date('2026-01-05T21:30:00Z'))).toBe('2026-01-05');
  });

  it('sets max-age to the next close plus 30 minutes', () => {
    expect(cacheMaxAgeSeconds('HK', MONDAY_MORNING_UTC)).toBe(81_360);
    expect(cacheMaxAgeSeconds('US', MONDAY_MORNING_UTC)).toBe(38_160);
  });

  it('rejects a date that is not a calendar day', () => {
    expect(isAcceptableSessionDate('US', '2026-02-31', MONDAY_MORNING_UTC)).toBe(false);
    expect(isAcceptableSessionDate('US', '16-10-2026', MONDAY_MORNING_UTC)).toBe(false);
  });
});
