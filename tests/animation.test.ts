import { describe, expect, it } from 'vitest';
import { percentChange } from '../shared/model';
import { ESTABLISH_END, FRAME_COUNT, HOOK_END, REWIND_END, buildAnimation, priceAt } from '../src/render';

const rising = {
  displaySymbol: 'NVDA.US',
  name: 'NVIDIA Corporation',
  currency: 'USD',
  bars: Array.from({ length: 40 }, (_, index) => ({
    date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    close: 100 + index * 3,
  })),
};

describe('price animation', () => {
  const animation = buildAnimation(rising);

  it('opens on the answer, rewinds to the start, then plays out to the last close', () => {
    const last = 100 + 39 * 3;
    expect(priceAt(animation, 0)).toBe(last);
    expect(priceAt(animation, HOOK_END - 1)).toBe(last);
    expect(priceAt(animation, REWIND_END)).toBe(100);
    expect(priceAt(animation, ESTABLISH_END)).toBe(100);
    expect(priceAt(animation, FRAME_COUNT - 1)).toBe(last);
    expect(percentChange(last, 100)).toBeCloseTo(1.17);

    let rewind = animation.reveal[HOOK_END] ?? 0;
    for (let frame = HOOK_END; frame < REWIND_END; frame += 1) {
      const reveal = animation.reveal[frame] ?? 0;
      expect(reveal).toBeLessThanOrEqual(rewind + 1e-6);
      rewind = reveal;
    }

    let play = -1;
    for (let frame = ESTABLISH_END; frame < FRAME_COUNT; frame += 1) {
      const reveal = animation.reveal[frame] ?? 0;
      expect(reveal).toBeGreaterThanOrEqual(play - 1e-6);
      play = reveal;
    }
  });

  it('keeps the visible price inside a smooth y range', () => {
    let previousMin = animation.yMin[0] ?? 0;
    let previousMax = animation.yMax[0] ?? 0;
    for (let frame = 0; frame < FRAME_COUNT; frame += 30) {
      const price = priceAt(animation, frame);
      const yMin = animation.yMin[frame] ?? 0;
      const yMax = animation.yMax[frame] ?? 0;
      expect(yMin).toBeLessThanOrEqual(price);
      expect(yMax).toBeGreaterThanOrEqual(price);
      expect(Math.abs(yMin - previousMin)).toBeLessThan(40);
      expect(Math.abs(yMax - previousMax)).toBeLessThan(40);
      previousMin = yMin;
      previousMax = yMax;
    }
  });

  it('keeps one full-history scale for the whole film', () => {
    expect(animation.lowIndex).toBe(0);
    expect(animation.highIndex).toBe(39);
    expect(animation.windowLeft[0]).toBe(0);
    expect(animation.windowRight[0]).toBeCloseTo(39);
    expect(animation.windowLeft[400]).toBe(0);
    expect(animation.windowRight[FRAME_COUNT - 1]).toBeCloseTo(39);
    expect(animation.yMin[0]).toBe(animation.yMin[FRAME_COUNT - 1]);
    expect(animation.yMax[0]).toBe(animation.yMax[FRAME_COUNT - 1]);
    expect(animation.yMin[0] ?? 0).toBeLessThan(100);
    expect(animation.yMax[0] ?? 0).toBeGreaterThan(217);
    expect(animation.yearsLabel).toBe('in 1 year');
    expect(Math.max(...animation.zoom)).toBeLessThanOrEqual(1.036 + 1e-3);
    expect(Math.min(...animation.zoom)).toBeGreaterThanOrEqual(0.978 - 1e-3);

    const longer = buildAnimation({
      displaySymbol: 'NVDA.US',
      name: 'NVIDIA',
      currency: 'USD',
      bars: Array.from({ length: 400 }, (_, index) => ({
        date: new Date(Date.UTC(2022, 0, 1 + index)).toISOString().slice(0, 10),
        close: 50 + Math.sin(index / 12) * 8 + index * 0.2,
      })),
    });
    const low = Math.min(...longer.prices);
    const high = Math.max(...longer.prices);
    expect(longer.windowLeft[400]).toBe(0);
    expect(longer.windowRight[400]).toBeCloseTo(399);
    expect(longer.yMin[0] ?? 0).toBeLessThan(low);
    expect(longer.yMax[0] ?? 0).toBeGreaterThan(high);
  });

  it('rejects a single close', () => {
    expect(() =>
      buildAnimation({
        displaySymbol: 'NVDA.US',
        name: 'NVIDIA',
        currency: 'USD',
        bars: [{ date: '2024-01-02', close: 10 }],
      }),
    ).toThrow(/two closing/);
  });
});
