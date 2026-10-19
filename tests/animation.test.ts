import { describe, expect, it } from 'vitest';
import { percentChange } from '../shared/model';
import { formatPercent, formatPrice } from '../src/insights';
import { ESTABLISH_END, FRAME_COUNT, HOOK_END, PLAY_END, REWIND_END, buildAnimation, frameReading, priceAt } from '../src/render';

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

  it('keeps the visible price inside an eased y range', () => {
    for (let frame = 0; frame < FRAME_COUNT; frame += 15) {
      const price = priceAt(animation, frame);
      expect(animation.yMin[frame] ?? 0).toBeLessThanOrEqual(price + 1e-6);
      expect(animation.yMax[frame] ?? 0).toBeGreaterThanOrEqual(price - 1e-6);
    }
    let previousMin = animation.yMin[ESTABLISH_END] ?? 0;
    let previousMax = animation.yMax[ESTABLISH_END] ?? 0;
    for (let frame = ESTABLISH_END; frame < PLAY_END; frame += 30) {
      const yMin = animation.yMin[frame] ?? 0;
      const yMax = animation.yMax[frame] ?? 0;
      expect(Math.abs(yMin - previousMin)).toBeLessThan(30);
      expect(Math.abs(yMax - previousMax)).toBeLessThan(30);
      previousMin = yMin;
      previousMax = yMax;
    }
  });

  it('frames the revealed window, then pulls out to a readable full history', () => {
    expect(animation.lowIndex).toBe(0);
    expect(animation.highIndex).toBe(39);
    expect(animation.yearsLabel).toBe('in 1 year');
    expect(animation.windowLeft[0]).toBe(0);
    expect(animation.windowRight[FRAME_COUNT - 1]).toBeCloseTo(39);
    expect(animation.yMin[FRAME_COUNT - 1] ?? 0).toBeLessThan(100);
    expect(animation.yMax[FRAME_COUNT - 1] ?? 0).toBeGreaterThan(217);

    const longer = buildAnimation({
      displaySymbol: 'NVDA.US',
      name: 'NVIDIA',
      currency: 'USD',
      bars: Array.from({ length: 400 }, (_, index) => ({
        date: new Date(Date.UTC(2022, 0, 1 + index)).toISOString().slice(0, 10),
        close: index < 80 ? 20 + Math.sin(index / 5) : 20 + (index - 80) * 0.8,
      })),
    });
    let early = ESTABLISH_END;
    while (early < PLAY_END && (longer.reveal[early] ?? 0) < 40) early += 1;
    const reveal = longer.reveal[early] ?? 0;
    expect(longer.windowRight[early] ?? 0).toBeGreaterThanOrEqual(reveal - 0.2);
    expect((longer.windowRight[early] ?? 0) - (longer.windowLeft[early] ?? 0)).toBeLessThan(200);
    expect(longer.yMax[early] ?? 0).toBeLessThan(80);
    expect(longer.logMix[early]).toBe(0);
    expect(longer.windowLeft[FRAME_COUNT - 1]).toBe(0);
    expect(longer.windowRight[FRAME_COUNT - 1]).toBeCloseTo(399);
    expect(longer.logMix[FRAME_COUNT - 1]).toBe(0);
    const low = Math.min(...longer.prices);
    const high = Math.max(...longer.prices);
    expect(longer.yMin[FRAME_COUNT - 1] ?? 0).toBeLessThan(low);
    expect(longer.yMax[FRAME_COUNT - 1] ?? 0).toBeGreaterThan(high);

    const flat = buildAnimation({
      displaySymbol: 'FLAT.US',
      name: 'Flat',
      currency: 'USD',
      bars: Array.from({ length: 80 }, (_, index) => ({
        date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
        close: 50 + Math.sin(index / 9),
      })),
    });
    expect(flat.logMix[FRAME_COUNT - 1]).toBe(0);
    expect(flat.yMin[FRAME_COUNT - 1] ?? 0).toBeLessThan(Math.min(...flat.prices));
    expect(flat.yMax[FRAME_COUNT - 1] ?? 0).toBeGreaterThan(Math.max(...flat.prices));
  });

  it('uses one revealed price for the hero, the cards, and a drawdown callout', () => {
    const crash = buildAnimation({
      displaySymbol: 'NVDA.US',
      name: 'NVIDIA',
      currency: 'USD',
      bars: Array.from({ length: 160 }, (_, index) => ({
        date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
        close: index < 40 ? 80 : index < 100 ? 80 - (index - 40) * 0.9 : 26 + (index - 100) * 0.4,
      })),
    });
    let sawCallout = false;
    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const reading = frameReading(crash, frame);
      expect(reading.cagrTo).toBe(reading.price);
      expect(reading.price).toBe(priceAt(crash, frame));
      expect(formatPrice('USD', reading.cagrTo)).toBe(formatPrice('USD', reading.price));
      expect(reading.low).toBeLessThanOrEqual(reading.price + 1e-6);
      expect(reading.high).toBeGreaterThanOrEqual(reading.price - 1e-6);
      expect(reading.low).toBeLessThanOrEqual(reading.dropTrough + 1e-6);
      if (reading.calloutDrop !== null) {
        sawCallout = true;
        expect(reading.calloutDrop).toBe(reading.drop);
        expect(reading.calloutText?.startsWith(formatPercent(reading.drop))).toBe(true);
      }
    }
    expect(sawCallout).toBe(true);
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
