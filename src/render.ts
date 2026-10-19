import { percentChange } from '../shared/model';

export const FPS = 60;
/** 15 seconds. Draw, pull out to the full range, then hold the verdict. */
export const FRAME_COUNT = FPS * 15;

const DRAW_END = 660;
const PULL_END = 780;
const START_VALUE = 10_000;

const WIDTH = 1920;
const HEIGHT = 1080;
const PLOT = { x: 236, y: 430, w: 1628, h: 566 };

const UP = '#3DDC97';
const DOWN = '#FF5D6C';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Animation {
  symbol: string;
  name: string;
  currency: string;
  dates: string[];
  prices: number[];
  smooth: number[];
  reveal: Float64Array;
  yMin: Float64Array;
  yMax: Float64Array;
  windowLeft: Float64Array;
  windowRight: Float64Array;
  highIndex: number;
  lowIndex: number;
  yearsLabel: string;
}

interface Point {
  x: number;
  y: number;
  value: number;
}

interface Run {
  above: boolean;
  points: Point[];
}

export function buildAnimation(input: {
  displaySymbol: string;
  name: string;
  currency: string;
  bars: readonly { date: string; close: number }[];
}): Animation {
  const bars = input.bars
    .filter((bar) => Number.isFinite(bar.close))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (bars.length < 2) throw new Error('Need at least two closing prices');

  const prices = bars.map((bar) => bar.close);
  const dates = bars.map((bar) => bar.date);
  const count = prices.length;
  const open = prices[0] ?? 0;
  const smooth = gaussianSmooth(prices, count > 80 ? 4 : 1);
  const highIndex = extremeIndex(prices, 'high');
  const lowIndex = extremeIndex(prices, 'low');
  pinExtreme(smooth, prices, highIndex);
  pinExtreme(smooth, prices, lowIndex);

  const windowSize = chooseWindow(count);
  const reveal = new Float64Array(FRAME_COUNT);
  const yMin = new Float64Array(FRAME_COUNT);
  const yMax = new Float64Array(FRAME_COUNT);
  const windowLeft = new Float64Array(FRAME_COUNT);
  const windowRight = new Float64Array(FRAME_COUNT);
  const full = paddedRange(Math.min(...prices), Math.max(...prices), open);
  const opening = targetWindow(0, count, windowSize);
  let left = opening.left;
  let right = opening.right;
  let lo = open;
  let hi = open;
  let snapLeft = left;
  let snapRight = right;
  let snapLo = lo;
  let snapHi = hi;

  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const playhead = revealProgress(frame) * (count - 1);
    reveal[frame] = playhead;
    const price = sample(prices, playhead);

    if (frame <= DRAW_END) {
      const target = targetWindow(playhead, count, windowSize);
      left += (target.left - left) * 0.06;
      right += (target.right - right) * 0.06;
      ({ left, right } = containPlayhead(left, right, playhead, count));
      const span = visibleRange(prices, left, playhead);
      const pad = Math.max((span.max - span.min) * 0.16, Math.abs(span.max) * 0.03, 0.5);
      const next = enforceSpan(lo, hi, span.min - pad, span.max + pad, price, Math.max(open * 0.08, 1));
      lo = next.lo;
      hi = next.hi;
      if (frame === DRAW_END) {
        snapLeft = left;
        snapRight = right;
        snapLo = lo;
        snapHi = hi;
      }
    } else if (frame <= PULL_END) {
      const u = smoothstep((frame - DRAW_END) / (PULL_END - DRAW_END));
      left = snapLeft + (0 - snapLeft) * u;
      right = snapRight + (count - 1 - snapRight) * u;
      lo = snapLo + (full.lo - snapLo) * u;
      hi = snapHi + (full.hi - snapHi) * u;
      const next = enforceSpan(lo, hi, lo, hi, price, 1);
      lo = next.lo;
      hi = next.hi;
    } else {
      left = 0;
      right = count - 1;
      lo = full.lo;
      hi = full.hi;
    }

    windowLeft[frame] = left;
    windowRight[frame] = right;
    yMin[frame] = lo;
    yMax[frame] = hi;
  }

  return {
    symbol: input.displaySymbol,
    name: presentName(input.name),
    currency: input.currency,
    dates,
    prices,
    smooth,
    reveal,
    yMin,
    yMax,
    windowLeft,
    windowRight,
    highIndex,
    lowIndex,
    yearsLabel: yearsPhrase(dates[0] ?? '', dates[dates.length - 1] ?? ''),
  };
}

export function priceAt(animation: Animation, frame: number): number {
  const index = animation.reveal[clampFrame(frame)] ?? 0;
  return sample(animation.prices, index);
}

export function drawFrame(ctx: Ctx, animation: Animation, frame: number): void {
  const index = clampFrame(frame);
  const playhead = animation.reveal[index] ?? 0;
  const open = animation.prices[0] ?? 0;
  const price = sample(animation.prices, playhead);
  const value = priceToValue(price, open);
  const left = animation.windowLeft[index] ?? 0;
  const right = animation.windowRight[index] ?? 1;
  const yMin = animation.yMin[index] ?? price;
  const yMax = animation.yMax[index] ?? price;
  const hold = index < PULL_END ? 0 : Math.min(1, (index - PULL_END) / 18);
  const canvas = ctx.canvas;
  ctx.setTransform(canvas.width / WIDTH, 0, 0, canvas.height / HEIGHT, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  const background = ctx.createRadialGradient(980, 460, 120, 960, 560, 1100);
  background.addColorStop(0, '#141820');
  background.addColorStop(0.62, '#0c0e13');
  background.addColorStop(1, '#07080b');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  drawIdentity(ctx, animation);
  drawLiveValue(ctx, animation, value, price, playhead, 1 - hold);
  if (hold > 0) drawVerdict(ctx, animation, hold);

  ctx.save();
  ctx.beginPath();
  ctx.rect(PLOT.x, PLOT.y, PLOT.w, PLOT.h);
  ctx.clip();
  drawGrid(ctx, yMin, yMax, open);
  const points = collectPoints(animation, playhead, left, right, yMin, yMax);
  const runs = splitRuns(points, START_VALUE);
  const startY = yAt(open, yMin, yMax);
  for (const run of runs) drawArea(ctx, run, startY);
  for (const run of runs) drawRun(ctx, run);
  drawStartLine(ctx, startY);
  ctx.restore();

  drawYLabels(ctx, yMin, yMax, open, animation.currency);
  drawStartLabel(ctx, animation.currency, startY);
  drawXLabels(ctx, animation.dates, left, right);
  if (animation.highIndex !== animation.lowIndex) {
    drawExtreme(ctx, animation, 'peak', playhead, left, right, yMin, yMax);
    drawExtreme(ctx, animation, 'low', playhead, left, right, yMin, yMax);
  }
  const tip = points[points.length - 1];
  if (tip) drawHead(ctx, tip);
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawIdentity(ctx: Ctx, animation: Animation): void {
  const symbol = shortSymbol(animation.symbol);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 48px Geist, sans-serif';
  ctx.fillStyle = '#f4f7fb';
  ctx.fillText(symbol, 72, 78);
  ctx.font = '500 36px Geist, sans-serif';
  ctx.fillStyle = '#b7c0d0';
  const nameX = 72 + ctx.measureText(symbol).width + 22;
  ctx.fillText(trimText(ctx, animation.name, 980), nameX, 78);
  ctx.font = '400 22px Geist, sans-serif';
  ctx.fillStyle = '#8b93a3';
  ctx.textAlign = 'right';
  ctx.fillText('Data: Yahoo Finance', WIDTH - 72, 74);
  ctx.textAlign = 'left';
}

function drawLiveValue(
  ctx: Ctx,
  animation: Animation,
  value: number,
  price: number,
  playhead: number,
  alpha: number,
): void {
  if (alpha <= 0.01) return;
  const open = animation.prices[0] ?? 0;
  const gain = value - START_VALUE;
  const pct = open === 0 ? 0 : percentChange(price, open);
  const above = gain >= -0.5;
  const flat = Math.abs(gain) < 0.5;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 116px Geist, sans-serif';
  ctx.fillStyle = '#f7f8fb';
  drawTabular(ctx, formatWhole(animation.currency, value), 72, 214);

  const pill = flat
    ? `${formatWhole(animation.currency, 0)} · 0.0%`
    : `${above ? '▲' : '▼'} ${formatSignedWhole(animation.currency, gain)} · ${formatPercent(pct)}`;
  ctx.font = '600 38px Geist, sans-serif';
  const pillWidth = ctx.measureText(pill).width + 44;
  roundRect(ctx, 72, 236, pillWidth, 68, 34);
  ctx.fillStyle = flat ? 'rgba(255,255,255,0.08)' : above ? 'rgba(61,220,151,0.16)' : 'rgba(255,93,108,0.16)';
  ctx.fill();
  ctx.fillStyle = flat ? '#d5dbe6' : above ? '#8af0c0' : '#ff9aa3';
  ctx.fillText(pill, 94, 282);
  ctx.restore();

  const dateIndex = Math.min(animation.dates.length - 1, Math.max(0, Math.floor(playhead)));
  const when = animation.dates[dateIndex] ?? animation.dates[0] ?? '';
  const since = animation.dates[0] ?? when;
  ctx.font = '500 34px Geist, sans-serif';
  ctx.fillStyle = '#d5dbe6';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${monthYear(when)} since ${monthYear(since)}`, 72, 356);
  ctx.font = '500 28px Geist, sans-serif';
  ctx.fillStyle = '#9aa3b5';
  ctx.fillText(`Share price ${formatPrice(animation.currency, price)}`, 72, 398);
}

function drawVerdict(ctx: Ctx, animation: Animation, alpha: number): void {
  const last = animation.prices[animation.prices.length - 1] ?? animation.prices[0] ?? 0;
  const open = animation.prices[0] ?? 0;
  const end = priceToValue(last, open);
  const pct = open === 0 ? 0 : percentChange(last, open);
  const lead = `${formatWhole(animation.currency, START_VALUE)} → ${formatWhole(animation.currency, end)} · `;
  const pctText = formatPercent(pct);
  const tail = ` ${animation.yearsLabel}`;
  let size = 46;
  ctx.font = `600 ${size}px Geist, sans-serif`;
  while (size > 30 && ctx.measureText(`${lead}${pctText}${tail}`).width > 1680) {
    size -= 2;
    ctx.font = `600 ${size}px Geist, sans-serif`;
  }
  const width = ctx.measureText(`${lead}${pctText}${tail}`).width;
  const x = 72;
  const y = 214;
  const top = y - 46;
  ctx.save();
  ctx.globalAlpha = alpha;
  roundRect(ctx, x - 28, top, width + 56, 92, 20);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f7f8fb';
  ctx.fillText(lead, x, y);
  const leadWidth = ctx.measureText(lead).width;
  ctx.fillStyle = pct >= 0 ? UP : DOWN;
  ctx.fillText(pctText, x + leadWidth, y);
  ctx.fillStyle = '#f7f8fb';
  ctx.fillText(tail, x + leadWidth + ctx.measureText(pctText).width, y);
  ctx.restore();
}

function drawGrid(ctx: Ctx, yMin: number, yMax: number, open: number): void {
  const vMin = priceToValue(yMin, open);
  const vMax = priceToValue(yMax, open);
  const step = niceStep(vMax - vMin, 4);
  if (step <= 0) return;
  ctx.font = '500 28px Geist, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  const start = Math.ceil(vMin / step) * step;
  let lastY = -Infinity;
  for (let value = start; value <= vMax + step * 0.01; value += step) {
    const y = yAt(valueToPrice(value, open), yMin, yMax);
    if (y < PLOT.y + 24 || y > PLOT.y + PLOT.h - 24) continue;
    if (Math.abs(y - lastY) < 48) continue;
    lastY = y;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    ctx.moveTo(PLOT.x, y);
    ctx.lineTo(PLOT.x + PLOT.w, y);
    ctx.stroke();
  }
}

function drawYLabels(ctx: Ctx, yMin: number, yMax: number, open: number, currency: string): void {
  const vMin = priceToValue(yMin, open);
  const vMax = priceToValue(yMax, open);
  const step = niceStep(vMax - vMin, 4);
  if (step <= 0) return;
  ctx.font = '500 28px Geist, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const start = Math.ceil(vMin / step) * step;
  let lastY = -Infinity;
  for (let value = start; value <= vMax + step * 0.01; value += step) {
    const y = yAt(valueToPrice(value, open), yMin, yMax);
    if (y < PLOT.y + 24 || y > PLOT.y + PLOT.h - 24) continue;
    if (Math.abs(y - lastY) < 48) continue;
    lastY = y;
    ctx.fillStyle = '#d5dbe6';
    ctx.fillText(formatWhole(currency, value), PLOT.x - 16, y);
  }
}

function drawStartLine(ctx: Ctx, startY: number): void {
  if (startY < PLOT.y || startY > PLOT.y + PLOT.h) return;
  ctx.save();
  ctx.setLineDash([10, 10]);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PLOT.x, startY);
  ctx.lineTo(PLOT.x + PLOT.w, startY);
  ctx.stroke();
  ctx.restore();
}

function drawStartLabel(ctx: Ctx, currency: string, startY: number): void {
  if (startY < PLOT.y + 8 || startY > PLOT.y + PLOT.h - 8) return;
  const text = `START ${formatWhole(currency, START_VALUE)}`;
  ctx.font = '600 26px Geist, sans-serif';
  const width = ctx.measureText(text).width;
  const x = PLOT.x + PLOT.w - width - 28;
  const y = startY < PLOT.y + 36 ? startY + 28 : startY - 14;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f4f7fb';
  ctx.fillText(text, x, y);
}

function drawArea(ctx: Ctx, run: Run, startY: number): void {
  if (run.points.length < 2) return;
  const first = run.points[0];
  const last = run.points[run.points.length - 1];
  if (!first || !last) return;
  ctx.beginPath();
  traceCurve(ctx, run.points);
  ctx.lineTo(last.x, startY);
  ctx.lineTo(first.x, startY);
  ctx.closePath();
  ctx.fillStyle = run.above ? 'rgba(61,220,151,0.20)' : 'rgba(255,93,108,0.18)';
  ctx.fill();
}

function drawRun(ctx: Ctx, run: Run): void {
  if (run.points.length < 2) return;
  ctx.beginPath();
  traceCurve(ctx, run.points);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = run.above ? UP : DOWN;
  ctx.lineWidth = 5;
  ctx.stroke();
}

function drawHead(ctx: Ctx, tip: Point): void {
  ctx.beginPath();
  ctx.fillStyle = tip.value >= START_VALUE ? UP : DOWN;
  ctx.arc(tip.x, tip.y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = '#f7f8fb';
  ctx.arc(tip.x, tip.y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawExtreme(
  ctx: Ctx,
  animation: Animation,
  kind: 'peak' | 'low',
  playhead: number,
  left: number,
  right: number,
  yMin: number,
  yMax: number,
): void {
  const index = kind === 'peak' ? animation.highIndex : animation.lowIndex;
  const age = playhead - index;
  if (age < 0) return;
  const price = animation.prices[index];
  const date = animation.dates[index];
  if (price === undefined || !date) return;
  const x = xAt(index, left, right);
  const y = yAt(price, yMin, yMax);
  if (x < PLOT.x + 8 || x > PLOT.x + PLOT.w - 8) return;
  if (y < PLOT.y - 20 || y > PLOT.y + PLOT.h + 20) return;
  const fade = Math.min(1, age / 10);
  const value = priceToValue(price, animation.prices[0] ?? price);
  const above = value >= START_VALUE;
  const text = `${kind === 'peak' ? 'Peak' : 'Low'} ${formatWhole(animation.currency, value)} · ${monthYear(date)}`;
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.font = '600 26px Geist, sans-serif';
  const width = ctx.measureText(text).width + 24;
  const preferAbove = kind === 'peak';
  let chipY = preferAbove ? y - 34 : y + 34;
  if (chipY < PLOT.y + 22) chipY = y + 34;
  if (chipY > PLOT.y + PLOT.h - 22) chipY = y - 34;
  let chipX = x - width / 2;
  if (chipX < PLOT.x + 8) chipX = PLOT.x + 8;
  if (chipX + width > PLOT.x + PLOT.w - 8) chipX = PLOT.x + PLOT.w - 8 - width;
  ctx.strokeStyle = above ? UP : DOWN;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, chipY);
  ctx.stroke();
  roundRect(ctx, chipX, chipY - 18, width, 36, 10);
  ctx.fillStyle = 'rgba(8,10,14,0.88)';
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = above ? UP : DOWN;
  ctx.fillText(text, chipX + 12, chipY);
  ctx.beginPath();
  ctx.fillStyle = above ? UP : DOWN;
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawXLabels(ctx: Ctx, dates: readonly string[], left: number, right: number): void {
  const span = Math.max(1, right - left);
  ctx.font = '500 28px Geist, sans-serif';
  const sample = span < 80 ? 'Sep 28' : 'Sep 26';
  const slot = ctx.measureText(sample).width + 48;
  const count = Math.max(2, Math.min(7, Math.floor(PLOT.w / slot)));
  ctx.fillStyle = '#d5dbe6';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let lastRight = -Infinity;
  let lastText = '';
  const y = PLOT.y + PLOT.h + 18;
  for (let i = 0; i < count; i += 1) {
    const index = left + ((i + 0.5) / count) * span;
    const bar = Math.max(0, Math.min(dates.length - 1, Math.round(index)));
    const iso = dates[bar];
    if (!iso) continue;
    const text = span < 80 ? monthDay(iso) : shortMonth(iso);
    if (text === lastText) continue;
    const width = ctx.measureText(text).width;
    const x = xAt(bar, left, right);
    if (x - width / 2 < PLOT.x || x + width / 2 > PLOT.x + PLOT.w) continue;
    if (x - width / 2 < lastRight + 20) continue;
    ctx.fillText(text, x, y);
    lastRight = x + width / 2;
    lastText = text;
  }
}

function collectPoints(
  animation: Animation,
  playhead: number,
  left: number,
  right: number,
  yMin: number,
  yMax: number,
): Point[] {
  const open = animation.prices[0] ?? 0;
  const last = Math.min(animation.prices.length - 1, Math.max(0, playhead));
  const start = Math.max(0, Math.floor(left));
  const end = Math.min(animation.prices.length - 1, Math.floor(last));
  const step = Math.max(1, Math.floor(Math.max(1, end - start) / 480));
  const indexes: number[] = [];
  for (let i = start; i <= end; i += step) indexes.push(i);
  if (animation.highIndex >= start && animation.highIndex <= end) indexes.push(animation.highIndex);
  if (animation.lowIndex >= start && animation.lowIndex <= end) indexes.push(animation.lowIndex);
  indexes.push(playhead);
  indexes.sort((a, b) => a - b);
  const points: Point[] = [];
  let previous = -Infinity;
  for (const index of indexes) {
    if (index - previous < 1e-4) continue;
    previous = index;
    const drawn = visualPrice(animation, index, playhead);
    points.push({
      x: xAt(index, left, right),
      y: yAt(drawn, yMin, yMax),
      value: priceToValue(drawn, open),
    });
  }
  return points;
}

function splitRuns(points: readonly Point[], startValue: number): Run[] {
  const first = points[0];
  if (!first) return [];
  const runs: Run[] = [];
  let batch: Point[] = [first];
  let above = first.value >= startValue;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const point = points[i];
    if (!prev || !point) continue;
    const prevAbove = prev.value >= startValue;
    const pointAbove = point.value >= startValue;
    if (prevAbove !== pointAbove && point.value !== prev.value) {
      const t = (startValue - prev.value) / (point.value - prev.value);
      const mid: Point = {
        x: prev.x + (point.x - prev.x) * t,
        y: prev.y + (point.y - prev.y) * t,
        value: startValue,
      };
      batch.push(mid);
      runs.push({ above: prevAbove, points: batch });
      batch = [mid, point];
      above = pointAbove;
    } else {
      batch.push(point);
      above = pointAbove;
    }
  }
  runs.push({ above, points: batch });
  return runs;
}

function traceCurve(ctx: Ctx, points: readonly Point[]): void {
  const first = points[0];
  if (!first) return;
  ctx.moveTo(first.x, first.y);
  if (points.length < 3) {
    for (let i = 1; i < points.length; i += 1) {
      const point = points[i];
      if (point) ctx.lineTo(point.x, point.y);
    }
    return;
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    const point = points[i];
    const next = points[i + 1];
    if (!point || !next) continue;
    const xc = (point.x + next.x) / 2;
    const yc = (point.y + next.y) / 2;
    ctx.quadraticCurveTo(point.x, point.y, xc, yc);
  }
  const last = points[points.length - 1];
  if (last) ctx.lineTo(last.x, last.y);
}

function visualPrice(animation: Animation, index: number, playhead: number): number {
  const raw = sample(animation.prices, index);
  const smooth = sample(animation.smooth, index);
  const blend = Math.exp(-Math.abs(playhead - index) / 5);
  return smooth + (raw - smooth) * blend;
}

function revealProgress(frame: number): number {
  if (frame >= DRAW_END) return 1;
  const u = frame / DRAW_END;
  return 1 - (1 - u) ** 1.35;
}

function chooseWindow(count: number): number {
  const preferred = Math.round(count * 0.28);
  return Math.max(1, Math.min(count - 1, Math.max(preferred, Math.min(80, count - 1))));
}

function targetWindow(playhead: number, count: number, size: number): { left: number; right: number } {
  const pad = Math.max(2, size * 0.1);
  let right = playhead + pad;
  let left = right - size;
  if (right > count - 1) {
    right = count - 1;
    left = right - size;
  }
  if (left < 0) {
    left = 0;
    right = Math.min(count - 1, Math.max(pad, playhead + pad));
  }
  if (right <= left) right = Math.min(count - 1, left + 1);
  return { left, right };
}

function containPlayhead(
  left: number,
  right: number,
  playhead: number,
  count: number,
): { left: number; right: number } {
  if (playhead < left) {
    const shift = left - playhead;
    left -= shift;
    right -= shift;
  }
  if (playhead > right) {
    const shift = playhead - right;
    left += shift;
    right += shift;
  }
  if (right > count - 1) {
    const shift = right - (count - 1);
    right -= shift;
    left = Math.max(0, left - shift);
  }
  if (left < 0) left = 0;
  if (right <= left) right = Math.min(count - 1, left + 1);
  return { left, right };
}

function visibleRange(prices: readonly number[], left: number, playhead: number): { min: number; max: number } {
  const start = Math.max(0, Math.floor(left));
  const end = Math.min(prices.length - 1, Math.max(start, Math.ceil(playhead)));
  let min = sample(prices, playhead);
  let max = min;
  for (let i = start; i <= end; i += 1) {
    const value = prices[i];
    if (value === undefined) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function paddedRange(min: number, max: number, open: number): { lo: number; hi: number } {
  const pad = Math.max((max - min) * 0.14, Math.abs(max) * 0.03, open * 0.08, 1);
  return enforceSpan(min, max, min - pad, max + pad, min, pad);
}

function enforceSpan(
  lo: number,
  hi: number,
  targetLo: number,
  targetHi: number,
  price: number,
  minSpan: number,
): { lo: number; hi: number } {
  const expandLo = targetLo < lo;
  const expandHi = targetHi > hi;
  lo += (targetLo - lo) * (expandLo ? 0.08 : 0.03);
  hi += (targetHi - hi) * (expandHi ? 0.08 : 0.03);
  if (price < lo) lo = price;
  if (price > hi) hi = price;
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  if (price < lo) {
    hi -= lo - price;
    lo = price;
  }
  if (price > hi) {
    lo += price - hi;
    hi = price;
  }
  if (lo < 0) {
    hi -= lo;
    lo = 0;
    if (price > hi) hi = price;
  }
  return { lo, hi };
}

function extremeIndex(prices: readonly number[], kind: 'high' | 'low'): number {
  let index = 0;
  for (let i = 1; i < prices.length; i += 1) {
    const value = prices[i] ?? 0;
    const best = prices[index] ?? 0;
    if (kind === 'high' ? value > best : value < best) index = i;
  }
  return index;
}

function gaussianSmooth(values: readonly number[], radius: number): number[] {
  if (radius < 1) return values.slice();
  const sigma = radius / 2;
  const weights: number[] = [];
  for (let i = -radius; i <= radius; i += 1) weights.push(Math.exp(-0.5 * (i / sigma) ** 2));
  return values.map((_, index) => {
    let acc = 0;
    let weight = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const value = values[index + k];
      const w = weights[k + radius];
      if (value === undefined || w === undefined) continue;
      acc += value * w;
      weight += w;
    }
    return weight === 0 ? values[index] ?? 0 : acc / weight;
  });
}

function pinExtreme(smooth: number[], prices: readonly number[], index: number): void {
  const raw = prices[index];
  if (raw === undefined) return;
  smooth[index] = raw;
  for (let distance = 1; distance <= 3; distance += 1) {
    const blend = 1 - distance / 4;
    for (const neighbor of [index - distance, index + distance]) {
      const next = smooth[neighbor];
      const price = prices[neighbor];
      if (next === undefined || price === undefined) continue;
      smooth[neighbor] = next * (1 - blend) + price * blend;
    }
  }
}

function sample(prices: readonly number[], index: number): number {
  const i0 = Math.max(0, Math.min(prices.length - 1, Math.floor(index)));
  const i1 = Math.min(prices.length - 1, i0 + 1);
  const span = index - i0;
  const a = prices[i0] ?? 0;
  const b = prices[i1] ?? a;
  return a + (b - a) * span;
}

function priceToValue(price: number, open: number): number {
  if (open === 0) return START_VALUE;
  return (price / open) * START_VALUE;
}

function valueToPrice(value: number, open: number): number {
  if (open === 0) return 0;
  return (value / START_VALUE) * open;
}

function xAt(index: number, left: number, right: number): number {
  const span = Math.max(1e-6, right - left);
  return PLOT.x + ((index - left) / span) * PLOT.w;
}

function yAt(price: number, yMin: number, yMax: number): number {
  const span = Math.max(1e-6, yMax - yMin);
  return PLOT.y + PLOT.h - ((price - yMin) / span) * PLOT.h;
}

function clampFrame(frame: number): number {
  return Math.max(0, Math.min(FRAME_COUNT - 1, Math.floor(frame)));
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function yearsPhrase(start: string, end: string): string {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  const years = Number.isFinite(from) && Number.isFinite(to) ? (to - from) / (365.25 * 86_400_000) : 5;
  const rounded = Math.max(1, Math.round(years));
  return rounded === 1 ? 'in 1 year' : `in ${rounded} years`;
}

function presentName(name: string): string {
  const stripped = name
    .replace(/\b(incorporated|inc|corporation|corp|holdings|limited|ltd|group|co)\b\.?/gi, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = stripped || name.trim();
  if (base === base.toUpperCase()) {
    return base.toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
  }
  return base;
}

function shortSymbol(symbol: string): string {
  return symbol.endsWith('.US') ? symbol.slice(0, -3) : symbol;
}

function formatPrice(currency: string, value: number): string {
  const body = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = value < 0 ? '−' : '';
  if (currency === 'USD') return `${sign}$${body}`;
  if (currency === 'HKD') return `${sign}HK$${body}`;
  return `${sign}${body} ${currency}`.trim();
}

function formatWhole(currency: string, value: number): string {
  const rounded = Math.round(value);
  const amount = Math.abs(rounded) < 1 ? 0 : Math.abs(rounded);
  const body = amount.toLocaleString('en-US');
  const sign = rounded < 0 && amount !== 0 ? '−' : '';
  if (currency === 'USD') return `${sign}$${body}`;
  if (currency === 'HKD') return `${sign}HK$${body}`;
  return `${sign}${body} ${currency}`.trim();
}

function formatSignedWhole(currency: string, value: number): string {
  const body = formatWhole(currency, Math.abs(value));
  if (value > 0.5) return `+${body}`;
  if (value < -0.5) return `−${body}`;
  return body;
}

function formatPercent(fraction: number): string {
  const pct = fraction * 100;
  const digits = Math.abs(pct).toFixed(1);
  if (pct > 0) return `+${digits}%`;
  if (pct < 0) return `−${digits}%`;
  return '0.0%';
}

function monthYear(iso: string): string {
  const [year, month] = iso.split('-');
  const name = MONTHS[(Number(month) || 1) - 1] ?? 'Jan';
  return `${name} ${year ?? ''}`;
}

function shortMonth(iso: string): string {
  const [year, month] = iso.split('-');
  const name = MONTHS[(Number(month) || 1) - 1] ?? 'Jan';
  return `${name} ${(year ?? '').slice(2)}`;
}

function monthDay(iso: string): string {
  const [, month, day] = iso.split('-');
  const name = MONTHS[(Number(month) || 1) - 1] ?? 'Jan';
  return `${name} ${Number(day) || 1}`;
}

function niceStep(span: number, ticks: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const rough = span / ticks;
  const exponent = Math.floor(Math.log10(rough));
  const base = 10 ** exponent;
  const fraction = rough / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

function drawTabular(ctx: Ctx, text: string, x: number, y: number): void {
  const digit = ctx.measureText('0').width;
  let cursor = x;
  for (const char of text) {
    if (char >= '0' && char <= '9') {
      const width = ctx.measureText(char).width;
      ctx.fillText(char, cursor + (digit - width) / 2, y);
      cursor += digit;
    } else {
      ctx.fillText(char, cursor, y);
      cursor += ctx.measureText(char).width;
    }
  }
}

function trimText(ctx: Ctx, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}…`;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
