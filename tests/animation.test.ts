import { describe, expect, it } from 'vitest';
import { percentChange } from '../shared/model';
import { FRAME_COUNT, buildAnimation, priceAt } from '../src/render';

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

  it('starts on the first close and finishes on the last', () => {
    expect(priceAt(animation, 0)).toBe(100);
    expect(priceAt(animation, FRAME_COUNT - 1)).toBe(100 + 39 * 3);
    expect(percentChange(priceAt(animation, FRAME_COUNT - 1), 100)).toBeCloseTo(1.17);
  });

  it('moves forward every frame until the hold', () => {
    let previous = -1;
    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const reveal = animation.reveal[frame] ?? 0;
      expect(reveal).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = reveal;
    }
    expect(animation.reveal[FRAME_COUNT - 1]).toBeCloseTo(39);
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
