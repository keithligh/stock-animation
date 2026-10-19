import { describe, expect, it } from 'vitest';
import { percentChange } from '../shared/model';
import { formatPercent, roundMoney } from '../src/insights';
import {
  ESTABLISH_END,
  FRAME_COUNT,
  HOOK_END,
  PLAY_END,
  PLOT_FRAME,
  REWIND_END,
  RIGHT_PAD_RATIO,
  buildAnimation,
  framePhase,
  frameReadout,
  indexToX,
  placeMarkerBoxes,
  priceAt,
  verdictText,
  type Animation,
} from '../src/render';

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

  it('opens on the start, then plays out to the last close', () => {
    const last = 100 + 39 * 3;
    expect(priceAt(animation, 0)).toBe(100);
    expect(priceAt(animation, HOOK_END - 1)).toBe(100);
    expect(priceAt(animation, REWIND_END)).toBe(100);
    expect(priceAt(animation, ESTABLISH_END - 1)).toBe(100);
    expect(priceAt(animation, FRAME_COUNT - 1)).toBe(last);
    expect(percentChange(last, 100)).toBeCloseTo(1.17);
    expect(framePhase(0)).toBe('hook');
    expect(framePhase(HOOK_END)).toBe('hook');
    expect(framePhase(ESTABLISH_END)).toBe('travel');
    expect(framePhase(PLAY_END)).toBe('verdict');
    expect(framePhase(FRAME_COUNT - 1)).toBe('verdict');

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

  it('reads hero, cards, and callouts from the same revealed prices', () => {
    const start = Date.parse('2021-10-01T00:00:00Z');
    const bars = Array.from({ length: 180 }, (_, index) => {
      let close = 100;
      if (index < 40) close = 100 + index;
      else if (index < 110) close = 139 - (index - 40) * 1.6;
      else close = 27 + (index - 110) * 0.8;
      return {
        date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
        close,
      };
    });
    const animation = buildAnimation({
      displaySymbol: 'NVDA.US',
      name: 'NVIDIA',
      currency: 'USD',
      bars,
    });
    const frames = [0, 72, HOOK_END, REWIND_END, ESTABLISH_END, 480, 720, 960, 1200, PLAY_END, FRAME_COUNT - 1];
    let sawDrawdown = false;
    for (const frame of frames) {
      assertOneReadout(animation, frame);
      expect(animation.windowLeft[frame]).toBe(0);
      expect(animation.yMin[frame] ?? 0).toBeLessThanOrEqual((animation.prices[0] ?? 0) + 1e-6);
      expect(animation.yMax[frame] ?? 0).toBeGreaterThanOrEqual((animation.prices[0] ?? 0) - 1e-6);
    }
    for (let frame = ESTABLISH_END; frame < PLAY_END; frame += 12) {
      const read = frameReadout(animation, frame);
      assertOneReadout(animation, frame);
      if (read.calloutKind === 'drawdown') {
        sawDrawdown = true;
        expect(read.calloutFraction).toBeCloseTo(read.drop);
        expect(read.calloutText?.startsWith(formatPercent(read.drop))).toBe(true);
      }
      expect(animation.windowLeft[frame]).toBe(0);
      expect(animation.windowRight[frame] ?? 0).toBeGreaterThanOrEqual((animation.reveal[frame] ?? 0) - 0.05);
    }
    expect(sawDrawdown).toBe(true);
    const final = frameReadout(animation, FRAME_COUNT - 1);
    expect(frameReadout(animation, 0).price).toBe(frameReadout(animation, 0).open);
    expect(verdictText(animation.currency, final)).toBe(
      `$${final.open.toFixed(2)} → $${final.price.toFixed(2)} · ${final.cagrText} · ${formatPercent(final.drop)} max drop`,
    );
    expect(final.cagrText.endsWith('/yr')).toBe(true);
    expect(final.years).toBeGreaterThan(0.4);
    const plain = final.open === 0 ? 0 : final.price / final.open - 1;
    expect(final.cagr).toBeCloseTo((final.price / final.open) ** (1 / final.years) - 1);
    expect(Math.abs(final.cagr - plain)).toBeGreaterThan(0.05);
  });

  it('keeps an open future to the right of the playhead until the end', () => {
    const frame = ESTABLISH_END + Math.floor((PLAY_END - ESTABLISH_END) * 0.35);
    const reveal = animation.reveal[frame] ?? 0;
    const right = animation.windowRight[frame] ?? 0;
    expect(animation.reveal[72]).toBe(0);
    expect(animation.windowRight[72] ?? 0).toBeLessThan(39);
    expect(right).toBeGreaterThan(reveal + 1);
    expect((right - reveal) / Math.max(right, 1)).toBeGreaterThan(0.18);
    expect(animation.windowRight[FRAME_COUNT - 1]).toBeCloseTo(39);
  });

  it('keeps about 9% of the plot clear to the right of the endpoint', () => {
    const x = indexToX(39, 0, 39);
    const pad = (PLOT_FRAME.x + PLOT_FRAME.w - x) / PLOT_FRAME.w;
    expect(pad).toBeGreaterThan(0.08);
    expect(pad).toBeLessThan(0.1);
    expect(RIGHT_PAD_RATIO).toBeCloseTo(0.09);
  });

  it('places one label per anchor and keeps callouts off the line', () => {
    const bounds = { x: 0, y: 0, w: 1000, h: 600 };
    const samePoint = placeMarkerBoxes(
      [
        { kind: 'now', ax: 800, ay: 120, w: 140, h: 26 },
        { kind: 'peak', ax: 806, ay: 126, w: 180, h: 26 },
      ],
      [],
      bounds,
    );
    expect(samePoint[0]).not.toBeNull();
    expect(samePoint[1]).toBeNull();

    const end = placeMarkerBoxes(
      [
        { kind: 'now', ax: 860, ay: 140, w: 150, h: 26 },
        { kind: 'peak', ax: 790, ay: 70, w: 200, h: 26 },
        { kind: 'start', ax: 48, ay: 420, w: 150, h: 26 },
      ],
      [{ x1: 48, y1: 420, x2: 860, y2: 140 }],
      bounds,
    );
    expect(end.every((box) => box !== null)).toBe(true);
    expect(boxesOverlap(end[0], end[1])).toBe(false);
    expect(boxesOverlap(end[0], end[2])).toBe(false);
    expect(boxesOverlap(end[1], end[2])).toBe(false);

    const callout = placeMarkerBoxes(
      [{ kind: 'callout', ax: 700, ay: 300, w: 220, h: 40 }],
      [{ x1: 0, y1: 300, x2: 1000, y2: 300 }],
      bounds,
    );
    const box = callout[0];
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.y + box.h < 300 - 4 || box.y > 300 + 4).toBe(true);
    expect(leadTo(box, 700, 300)).toBeLessThanOrEqual(108);

    const blocked: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let y = 270; y <= 480; y += 8) blocked.push({ x1: 360, y1: y, x2: 794, y2: y });
    const parked = placeMarkerBoxes([{ kind: 'callout', ax: 700, ay: 400, w: 240, h: 40 }], blocked, {
      x: 0,
      y: 0,
      w: 800,
      h: 500,
    });
    const parkedBox = parked[0];
    expect(parkedBox).not.toBeNull();
    if (!parkedBox) return;
    expect(leadTo(parkedBox, 700, 400)).toBeGreaterThan(108);
    expect(rectsOverlap(parkedBox, { x: 360, y: 270, w: 434, h: 210 }, 0)).toBe(false);
    expect(parkedBox.x).toBeGreaterThanOrEqual(6);
    expect(parkedBox.y).toBeGreaterThanOrEqual(6);
    expect(parkedBox.x + parkedBox.w).toBeLessThanOrEqual(794);
    expect(parkedBox.y + parkedBox.h).toBeLessThanOrEqual(494);
  });

  it('keeps a wide start label and a peak beside NOW inside the plot', () => {
    const bounds = { x: 180, y: 20, w: 1500, h: 560 };
    const start = placeMarkerBoxes(
      [{ kind: 'start', ax: 230, ay: 500, w: 340, h: 32 }],
      [{ x1: 180, y1: 500, x2: 1500, y2: 500 }],
      bounds,
    );
    const startBox = start[0];
    expect(startBox).not.toBeNull();
    if (startBox) {
      expect(startBox.x).toBeGreaterThanOrEqual(bounds.x);
      expect(startBox.x + startBox.w).toBeLessThanOrEqual(bounds.x + bounds.w);
      expect(startBox.y + startBox.h < 494 || startBox.y > 506).toBe(true);
    }

    const pair = placeMarkerBoxes(
      [
        { kind: 'now', ax: 1520, ay: 120, w: 260, h: 32 },
        { kind: 'peak', ax: 1460, ay: 64, w: 280, h: 32 },
      ],
      [{ x1: 200, y1: 480, x2: 1520, y2: 120 }],
      { x: 160, y: 16, w: 1560, h: 560 },
    );
    expect(pair[0]).not.toBeNull();
    expect(pair[1]).not.toBeNull();
    expect(boxesOverlap(pair[0], pair[1])).toBe(false);
  });

  it('keeps START readable on a chart whose low sits near the open', () => {
    const bounds = { x: 220, y: 426, w: 1608, h: 528 };
    const line = 913;
    const boxes = placeMarkerBoxes(
      [
        { kind: 'now', ax: 1683, ay: 563, w: 289, h: 32 },
        { kind: 'peak', ax: 1674, ay: 518, w: 302, h: 32 },
        { kind: 'low', ax: 536, ay: 934, w: 276, h: 32 },
        { kind: 'start', ax: 252, ay: line, w: 302, h: 32 },
      ],
      [
        { x1: 220, y1: line, x2: 1828, y2: line },
        { x1: 252, y1: line, x2: 400, y2: 890 },
        { x1: 400, y1: 890, x2: 536, y2: 934 },
        { x1: 536, y1: 934, x2: 760, y2: 860 },
        { x1: 760, y1: 860, x2: 1674, y2: 518 },
        { x1: 1674, y1: 518, x2: 1683, y2: 563 },
      ],
      bounds,
    );
    expect(boxes.every((box) => box !== null)).toBe(true);
    const low = boxes[2];
    const start = boxes[3];
    if (!low || !start) return;
    expect(boxesOverlap(start, low)).toBe(false);
    expect(low.x > 252 + 8 || low.x + low.w < 252 - 8).toBe(true);
    expect(start.y + start.h <= line - 18 || start.y >= line + 18).toBe(true);
    expect(start.x).toBeGreaterThanOrEqual(bounds.x);
    expect(start.y).toBeGreaterThanOrEqual(bounds.y);
    expect(start.x + start.w).toBeLessThanOrEqual(bounds.x + bounds.w);
    expect(start.y + start.h).toBeLessThanOrEqual(bounds.y + bounds.h);
  });

  it('floats START off the open-price line when the path returns to it', () => {
    const bounds = { x: 220, y: 426, w: 1608, h: 528 };
    const line = 698;
    const boxes = placeMarkerBoxes(
      [
        { kind: 'now', ax: 1082, ay: 857, w: 276, h: 32 },
        { kind: 'peak', ax: 348, ay: 507, w: 289, h: 32 },
        { kind: 'low', ax: 1068, ay: 873, w: 276, h: 32 },
        { kind: 'start', ax: 252, ay: line, w: 302, h: 32 },
      ],
      [
        { x1: 220, y1: line, x2: 1828, y2: line },
        { x1: 252, y1: line, x2: 348, y2: 507 },
        { x1: 348, y1: 507, x2: 620, y2: line + 6 },
        { x1: 620, y1: line + 6, x2: 1082, y2: 857 },
      ],
      bounds,
    );
    const start = boxes[3];
    expect(start).not.toBeNull();
    if (!start) return;
    expect(start.y >= line + 22 || start.y + start.h <= line - 22).toBe(true);
    expect(boxesOverlap(start, boxes[0])).toBe(false);
    expect(boxesOverlap(start, boxes[1])).toBe(false);
    expect(boxesOverlap(start, boxes[2])).toBe(false);
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

function assertOneReadout(animation: Animation, frame: number): void {
  const read = frameReadout(animation, frame);
  expect(read.price).toBe(roundMoney(priceAt(animation, frame)));
  expect(read.price).toBe(roundMoney(read.price));
  expect(read.open).toBe(roundMoney(read.open));
  expect(read.high).toBe(roundMoney(read.high));
  expect(read.low).toBe(roundMoney(read.low));
  expect(read.dropPeak).toBe(roundMoney(read.dropPeak));
  expect(read.dropTrough).toBe(roundMoney(read.dropTrough));
  expect(read.delta).toBe(roundMoney(read.price - read.open));
  expect(read.high).toBeGreaterThanOrEqual(read.price);
  expect(read.low).toBeLessThanOrEqual(read.price);
  expect(read.dropPeak).toBeGreaterThan(0);
  expect(read.drop).toBeCloseTo(read.dropTrough / read.dropPeak - 1, 8);
  expect(read.change).toBeCloseTo(read.open === 0 ? 0 : read.price / read.open - 1, 8);
  expect(read.cagrText).toBe(`${formatPercent(read.cagr)}/yr`);
}

function leadTo(box: { x: number; y: number; w: number; h: number }, ax: number, ay: number): number {
  const x = Math.max(box.x, Math.min(ax, box.x + box.w));
  const y = Math.max(box.y, Math.min(ay, box.y + box.h));
  return Math.hypot(x - ax, y - ay);
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  pad: number,
): boolean {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number } | null,
  b: { x: number; y: number; w: number; h: number } | null,
): boolean {
  if (!a || !b) return false;
  return a.x < b.x + b.w + 8 && a.x + a.w + 8 > b.x && a.y < b.y + b.h + 8 && a.y + a.h + 8 > b.y;
}
