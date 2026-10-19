import { describe, expect, it } from 'vitest';
import { buildModel, percentChange, valueAt } from '../shared/model';

describe('percent change', () => {
  it('rebases to the first close and starts at 0', () => {
    expect(percentChange(100, 100)).toBe(0);
    expect(percentChange(110, 100)).toBeCloseTo(0.1);
    expect(percentChange(90, 100)).toBeCloseTo(-0.1);
  });

  it('refuses a zero baseline', () => {
    expect(() => percentChange(5, 0)).toThrow(/non-zero/);
  });
});

describe('compare model', () => {
  const tencent = {
    displaySymbol: '0700.HK',
    yahooSymbol: '0700.HK',
    name: 'TENCENT',
    currency: 'HKD',
    bars: [
      { date: '2024-06-03', close: 100 },
      { date: '2024-06-04', close: 110 },
      { date: '2024-06-06', close: 90 },
    ],
  };
  const nvidia = {
    displaySymbol: 'NVDA.US',
    yahooSymbol: 'NVDA',
    name: 'NVIDIA Corporation',
    currency: 'USD',
    bars: [
      { date: '2024-06-04', close: 50 },
      { date: '2024-06-05', close: 40 },
    ],
  };

  it('uses price for one ticker and percent change for two, with no FX', () => {
    const alone = buildModel([tencent]);
    expect(alone.mode).toBe('price');
    expect(valueAt(alone.series[0]!, 'price', 0)).toBe(100);
    expect(alone.series[0]?.currency).toBe('HKD');

    const both = buildModel([tencent, nvidia]);
    expect(both.mode).toBe('change');
    expect(both.dates).toEqual(['2024-06-03', '2024-06-04', '2024-06-05', '2024-06-06']);
    expect(both.series[0]?.prices).toEqual([100, 110, 110, 90]);
    expect(both.series[0]?.changes.map((value) => (value === null ? null : Number(value.toFixed(6))))).toEqual([
      0, 0.1, 0.1, -0.1,
    ]);
    expect(both.series[1]?.prices).toEqual([null, 50, 40, 40]);
    expect(both.series[1]?.changes[0]).toBeNull();
    expect(both.series[1]?.changes[1]).toBe(0);
    expect(both.series[1]?.changes[2]).toBeCloseTo(-0.2);
    expect(both.series[1]?.changes[3]).toBeCloseTo(-0.2);
    expect(both.series[0]?.currency).toBe('HKD');
    expect(both.series[1]?.currency).toBe('USD');
  });

  it('ranks by the ending percent change', () => {
    const model = buildModel([tencent, nvidia]);
    expect(model.ranking.map((item) => [item.rank, item.displaySymbol])).toEqual([
      [1, '0700.HK'],
      [2, 'NVDA.US'],
    ]);
    expect(model.ranking[0]?.change).toBeCloseTo(-0.1);
    expect(model.ranking[1]?.change).toBeCloseTo(-0.2);
  });

  it('starts a later listing at its own first close', () => {
    const late = buildModel([
      {
        displaySymbol: 'NEW.US',
        yahooSymbol: 'NEW',
        name: 'New',
        currency: 'USD',
        bars: [
          { date: '2024-06-05', close: 20 },
          { date: '2024-06-06', close: 30 },
        ],
      },
    ]);
    expect(late.series[0]?.changes).toEqual([0, 0.5]);
  });

  it('rejects an empty set and a fifth series', () => {
    expect(() => buildModel([])).toThrow(/1 to 4/);
    const one = {
      displaySymbol: 'NVDA.US',
      yahooSymbol: 'NVDA',
      name: 'NVIDIA',
      currency: 'USD',
      bars: [{ date: '2024-06-03', close: 1 }],
    };
    expect(() => buildModel([one, one, one, one, one])).toThrow(/1 to 4/);
  });
});
