import { describe, expect, it } from 'vitest';
import {
  CALLOUT_FRAMES,
  ESTABLISH_END,
  FRAME_COUNT,
  LEAD_FRAMES,
  damp,
  detectEvents,
  growthSoFar,
  maxDrawdownSoFar,
  placeCallouts,
  playheadSeries,
  rangeSoFar,
  stepSpring,
  yearChapter,
  type MarketEvent,
} from '../src/insights';

function datesFrom(start: string, count: number): string[] {
  const origin = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => new Date(origin + index * 86_400_000).toISOString().slice(0, 10));
}

describe('live stats', () => {
  const prices = [100, 150, 90, 120];
  const dates = ['2022-01-03', '2022-03-01', '2022-06-01', '2022-09-01'];

  it('tracks the high and low so far', () => {
    expect(rangeSoFar(prices, dates, 0)).toMatchObject({ high: 100, low: 100, highDate: '2022-01-03' });
    expect(rangeSoFar(prices, dates, 2)).toMatchObject({
      high: 150,
      highDate: '2022-03-01',
      low: 90,
      lowDate: '2022-06-01',
    });
  });

  it('tracks the worst peak-to-trough drawdown without reading the future', () => {
    const early = maxDrawdownSoFar(prices, dates, 1);
    expect(early.depth).toBe(0);
    const fallen = maxDrawdownSoFar(prices, dates, 2);
    expect(fallen.depth).toBeCloseTo(90 / 150 - 1);
    expect(fallen.peak).toBe(150);
    expect(fallen.trough).toBe(90);
    expect(fallen.peakDate).toBe('2022-03-01');
    expect(fallen.troughDate).toBe('2022-06-01');
    expect(fallen.current).toBeCloseTo(90 / 150 - 1);
    const later = maxDrawdownSoFar(prices, dates, 3);
    expect(later.depth).toBeCloseTo(90 / 150 - 1);
    expect(later.current).toBeCloseTo(120 / 150 - 1);
  });

  it('uses a plain percent before one year and CAGR after', () => {
    const partial = growthSoFar(100, 110, '2024-01-02', '2024-06-01');
    expect(partial.annualized).toBe(false);
    expect(partial.rate).toBeCloseTo(0.1);
    expect(partial.years).toBeLessThan(1);

    const doubled = growthSoFar(100, 200, '2022-01-01', '2024-01-01');
    expect(doubled.annualized).toBe(true);
    expect(doubled.years).toBeGreaterThan(1.9);
    expect(doubled.rate).toBeCloseTo(2 ** (1 / doubled.years) - 1);
  });
});

describe('event detection', () => {
  it('marks a 20% drawdown, the biggest days, and the peak recovery', () => {
    const prices = [100, 130, 100, 70, 90, 150];
    const dates = ['2022-01-03', '2022-01-04', '2022-02-01', '2022-04-04', '2022-05-02', '2022-08-01'];
    const events = detectEvents(prices, dates, [], 'USD');
    const drawdown = events.find((event) => event.kind === 'drawdown');
    expect(drawdown?.anchor).toBe(3);
    expect(drawdown?.text).toMatch(/^−\$60\.00 · −46% in /);
    expect(events.some((event) => event.kind === 'up' && event.text.includes('+67%') && event.text.startsWith('+$60.00'))).toBe(true);
    expect(events.some((event) => event.kind === 'down' && event.index === 3)).toBe(true);
    expect(events.some((event) => event.kind === 'recovery' && event.text.startsWith('Recovered $130.00'))).toBe(true);
    expect(events.filter((event) => event.kind === 'recovery')).toHaveLength(1);
  });

  it('ignores a dip under 20% and still notes a return above the start', () => {
    const prices = [100, ...Array.from({ length: 24 }, () => 88), 110];
    const dates = datesFrom('2024-01-02', prices.length);
    const events = detectEvents(prices, dates, [], 'USD');
    expect(events.some((event) => event.kind === 'drawdown')).toBe(false);
    const recovery = events.find((event) => event.kind === 'recovery');
    expect(recovery?.text.startsWith('Back above $100.00 after')).toBe(true);
  });

  it('rolls dividends into a per-share total and skips an empty list', () => {
    const prices = [100, 100, 100, 100];
    const dates = datesFrom('2024-01-02', 4);
    expect(detectEvents(prices, dates, [], 'USD').some((event) => event.kind === 'dividend')).toBe(false);
    const events = detectEvents(
      prices,
      dates,
      [
        { date: dates[1] ?? '', amount: 0.4 },
        { date: dates[2] ?? '', amount: 0.6 },
      ],
      'USD',
    );
    const dividends = events.filter((event) => event.kind === 'dividend');
    expect(dividends.map((event) => event.text)).toEqual(['Dividends $0.40', 'Dividends $1.00']);
  });

  it('reads a calendar year return from the prior close', () => {
    const chapter = yearChapter([100, 110, 80], ['2021-12-30', '2021-12-31', '2022-01-03'], 2);
    expect(chapter.year).toBe(2022);
    expect(chapter.fraction).toBeCloseTo(80 / 110 - 1);
  });
});

describe('callout schedule', () => {
  const series = playheadSeries(300, [150]);
  const drawdown: MarketEvent = {
    kind: 'drawdown',
    index: 150,
    anchor: 150,
    priority: 0,
    score: 0.4,
    text: '−40% in 3 months',
  };

  it('announces a drawdown half a second before the line arrives', () => {
    const schedule = placeCallouts([drawdown], series);
    const arrive = series.findIndex((value, frame) => frame >= ESTABLISH_END && value >= 150);
    expect(schedule[0]?.startFrame).toBe(arrive - LEAD_FRAMES);
    expect(schedule[0]?.endFrame).toBe((schedule[0]?.startFrame ?? 0) + CALLOUT_FRAMES);
    expect(schedule[0]?.arriveFrame).toBe(arrive);
  });

  it('keeps one callout at a time and lets a drawdown take the slot from a dividend', () => {
    const day: MarketEvent = { ...drawdown, kind: 'down', priority: 2, score: 0.2, text: '−12% · Jun 1, 2022' };
    const dividend: MarketEvent = {
      kind: 'dividend',
      index: 150,
      anchor: 150,
      priority: 3,
      score: 0,
      text: 'Dividends $40',
    };
    const schedule = placeCallouts([dividend, day, drawdown], series);
    expect(schedule.some((item) => item.kind === 'dividend')).toBe(false);
    expect(schedule[0]?.kind).toBe('drawdown');
    expect(schedule[1]?.startFrame).toBeGreaterThanOrEqual(schedule[0]?.endFrame ?? 0);
    for (let i = 1; i < schedule.length; i += 1) {
      expect(schedule[i]?.startFrame).toBeGreaterThanOrEqual(schedule[i - 1]?.endFrame ?? 0);
    }
  });
});

describe('timeline', () => {
  it('holds the answer, rewinds, then dwells on the biggest move', () => {
    const count = 400;
    const quiet = playheadSeries(count, []);
    const warped = playheadSeries(count, [200]);
    expect(quiet[0]).toBe(count - 1);
    expect(quiet[ESTABLISH_END]).toBe(0);
    expect(quiet[FRAME_COUNT - 1]).toBe(count - 1);

    const speed = (series: Float64Array, index: number) => {
      let frame = ESTABLISH_END;
      while (frame < series.length && (series[frame] ?? 0) < index) frame += 1;
      return ((series[frame + 12] ?? 0) - (series[frame - 12] ?? 0)) / 24;
    };
    const ratio = speed(warped, 80) / speed(warped, 200);
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2);
  });

  it('eases in and out without spring overshoot', () => {
    expect(damp(0)).toBe(0);
    expect(damp(0.3)).toBeGreaterThan(damp(0.1));
    expect(damp(3)).toBeLessThanOrEqual(1);
    let value = 0;
    let velocity = 0;
    for (let step = 0; step < 120; step += 1) {
      const next = stepSpring(value, velocity, 1, 1 / 60, 8);
      expect(next.value).toBeGreaterThanOrEqual(-1e-6);
      expect(next.value).toBeLessThanOrEqual(1 + 1e-6);
      value = next.value;
      velocity = next.velocity;
    }
    expect(value).toBeGreaterThan(0.9);
  });
});
