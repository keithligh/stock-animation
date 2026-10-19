import { percentChange } from '../shared/model';

export const FPS = 60;
/** 15 seconds. Long enough to read, short enough to encode on a laptop. */
export const FRAME_COUNT = FPS * 15;
const HOLD_FRAMES = 78;

const WIDTH = 1920;
const HEIGHT = 1080;

export interface Animation {
  symbol: string;
  name: string;
  currency: string;
  dates: string[];
  prices: number[];
  reveal: Float64Array;
  yMin: Float64Array;
  yMax: Float64Array;
  windowLeft: Float64Array;
  windowRight: Float64Array;
}

interface Plot {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PLOT: Plot = { x: 88, y: 456, w: 1744, h: 508 };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

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
  const windowSize = chooseWindow(count);
  const reveal = new Float64Array(FRAME_COUNT);
  const yMin = new Float64Array(FRAME_COUNT);
  const yMax = new Float64Array(FRAME_COUNT);
  const windowLeft = new Float64Array(FRAME_COUNT);
  const windowRight = new Float64Array(FRAME_COUNT);

  const first = windowFor(0, count, windowSize);
  let left = first.left;
  let right = first.right;
  let lo = prices[0] ?? 0;
  let hi = lo;

  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const playhead = revealProgress(frame) * (count - 1);
    reveal[frame] = playhead;
    const target = windowFor(playhead, count, windowSize);
    left += (target.left - left) * 0.085;
    right += (target.right - right) * 0.085;
    if (playhead < left) left = playhead;
    if (playhead > right) right = playhead;
    windowLeft[frame] = left;
    windowRight[frame] = right;

    const span = visibleRange(prices, left, playhead);
    const pad = Math.max((span.max - span.min) * 0.22, Math.abs(span.max + span.min) * 0.01, 0.5);
    const targetLo = span.min - pad;
    const targetHi = span.max + pad;
    lo = approach(lo, targetLo, targetLo < lo);
    hi = approach(hi, targetHi, targetHi > hi);
    if (hi - lo < pad) {
      const mid = (hi + lo) / 2;
      lo = mid - pad;
      hi = mid + pad;
    }
    yMin[frame] = lo;
    yMax[frame] = hi;
  }

  return {
    symbol: input.displaySymbol,
    name: presentName(input.name),
    currency: input.currency,
    dates,
    prices,
    reveal,
    yMin,
    yMax,
    windowLeft,
    windowRight,
  };
}

export function priceAt(animation: Animation, frame: number): number {
  const index = animation.reveal[clampFrame(frame)] ?? 0;
  return sample(animation.prices, index);
}

export function drawFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  animation: Animation,
  frame: number,
): void {
  const index = clampFrame(frame);
  const playhead = animation.reveal[index] ?? 0;
  const price = sample(animation.prices, playhead);
  const open = animation.prices[0] ?? price;
  const left = animation.windowLeft[index] ?? 0;
  const right = animation.windowRight[index] ?? 1;
  const yMin = animation.yMin[index] ?? price;
  const yMax = animation.yMax[index] ?? price;
  const fade = Math.min(1, frame / 18);
  const above = price >= open;
  const canvas = ctx.canvas;
  ctx.setTransform(canvas.width / WIDTH, 0, 0, canvas.height / HEIGHT, 0, 0);
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  const background = ctx.createRadialGradient(980, 420, 160, 960, 560, 1180);
  background.addColorStop(0, '#161b24');
  background.addColorStop(0.58, '#0c0e13');
  background.addColorStop(1, '#07080b');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  drawType(ctx, animation, playhead, price, open, fade, above);
  drawGrid(ctx, yMin, yMax);
  drawBaseline(ctx, open, yMin, yMax, animation.currency);
  const points = linePoints(animation.prices, playhead, left, right, yMin, yMax);
  const tip = points[points.length - 1];
  if (points.length > 1) {
    drawArea(ctx, points, above);
    drawLine(ctx, points, above);
  }
  if (tip) drawTip(ctx, tip, shortSymbol(animation.symbol), animation.currency, price, fade);
  drawMonths(ctx, animation.dates, left, right);
  ctx.globalAlpha = 0.72;
  ctx.font = '400 18px "Geist Mono", ui-monospace, monospace';
  ctx.fillStyle = '#8b93a3';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Data: Yahoo Finance', WIDTH - 72, 1040);
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawType(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  animation: Animation,
  playhead: number,
  price: number,
  open: number,
  fade: number,
  above: boolean,
): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = 0.7;
  ctx.font = '500 15px Geist, sans-serif';
  ctx.fillStyle = '#9aa3b5';
  ctx.fillText('STOCK ANIMATION', 88, 72);
  ctx.globalAlpha = fade;
  ctx.font = '500 22px Geist, sans-serif';
  ctx.fillStyle = '#d5dbe6';
  const title = `${shortSymbol(animation.symbol)}   ${animation.name}`;
  ctx.fillText(trimText(ctx, title, 1100), 88, 128);

  ctx.font = '600 118px Geist, sans-serif';
  ctx.fillStyle = '#f7f8fb';
  drawTabular(ctx, formatPrice(animation.currency, price), 88, 286);

  const moved = price - open;
  const pct = open === 0 ? 0 : percentChange(price, open);
  const flat = Math.abs(moved) < 0.005;
  const pill = flat
    ? `${formatPrice(animation.currency, 0)}    0.0%`
    : `${above ? '▲' : '▼'}  ${formatSignedPrice(animation.currency, moved)}    ${formatPercent(pct)}`;
  ctx.font = '600 28px Geist, sans-serif';
  const pillWidth = ctx.measureText(pill).width + 36;
  roundRect(ctx, 88, 312, pillWidth, 48, 24);
  ctx.fillStyle = flat ? 'rgba(255,255,255,0.08)' : above ? 'rgba(62, 224, 143, 0.14)' : 'rgba(255, 93, 108, 0.14)';
  ctx.fill();
  ctx.fillStyle = flat ? '#c5ccd8' : above ? '#6ef0b0' : '#ff8d98';
  ctx.fillText(pill, 106, 345);

  const dateIndex = Math.min(animation.dates.length - 1, Math.max(0, Math.floor(playhead)));
  const when = animation.dates[dateIndex] ?? animation.dates[0] ?? '';
  const since = animation.dates[0] ?? when;
  ctx.font = '400 20px "Geist Mono", ui-monospace, monospace';
  ctx.fillStyle = '#8b93a3';
  ctx.fillText(`${monthYear(when)}    since    ${monthYear(since)}`, 88, 404);
  ctx.globalAlpha = 1;
}

function drawGrid(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  yMin: number,
  yMax: number,
): void {
  const step = niceStep(yMax - yMin, 4);
  if (step <= 0) return;
  ctx.font = '400 16px "Geist Mono", ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const start = Math.ceil(yMin / step) * step;
  for (let value = start; value <= yMax; value += step) {
    const y = yAt(value, yMin, yMax);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PLOT.x, y);
    ctx.lineTo(PLOT.x + PLOT.w, y);
    ctx.stroke();
    ctx.fillStyle = '#6f7888';
    ctx.fillText(compactNumber(value), PLOT.x - 14, y);
  }
}

function drawBaseline(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  open: number,
  yMin: number,
  yMax: number,
  currency: string,
): void {
  if (open < yMin || open > yMax) return;
  const y = yAt(open, yMin, yMax);
  ctx.save();
  ctx.setLineDash([4, 8]);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PLOT.x, y);
  ctx.lineTo(PLOT.x + PLOT.w, y);
  ctx.stroke();
  ctx.restore();
  ctx.font = '400 15px "Geist Mono", ui-monospace, monospace';
  ctx.fillStyle = '#8b93a3';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(formatPrice(currency, open), PLOT.x + PLOT.w, y - 8);
}

function drawArea(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
  above: boolean,
): void {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return;
  const gradient = ctx.createLinearGradient(0, PLOT.y, 0, PLOT.y + PLOT.h);
  gradient.addColorStop(0, above ? 'rgba(120, 235, 180, 0.28)' : 'rgba(255, 140, 150, 0.22)');
  gradient.addColorStop(1, above ? 'rgba(120, 235, 180, 0)' : 'rgba(255, 140, 150, 0)');
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point) ctx.lineTo(point.x, point.y);
  }
  ctx.lineTo(last.x, PLOT.y + PLOT.h);
  ctx.lineTo(first.x, PLOT.y + PLOT.h);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
}

function drawLine(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
  above: boolean,
): void {
  if (points.length < 2) return;
  const trace = () => {
    const first = points[0];
    if (!first) return;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i += 1) {
      const point = points[i];
      if (point) ctx.lineTo(point.x, point.y);
    }
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = above ? 'rgba(170, 255, 214, 0.20)' : 'rgba(255, 186, 192, 0.18)';
  ctx.lineWidth = 16;
  trace();
  ctx.stroke();
  ctx.strokeStyle = above ? 'rgba(210, 255, 232, 0.45)' : 'rgba(255, 214, 218, 0.40)';
  ctx.lineWidth = 6;
  trace();
  ctx.stroke();
  ctx.strokeStyle = '#f5f8fc';
  ctx.lineWidth = 2.6;
  trace();
  ctx.stroke();
}

function drawTip(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  tip: { x: number; y: number },
  symbol: string,
  currency: string,
  price: number,
  fade: number,
): void {
  ctx.beginPath();
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.arc(tip.x, tip.y, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = '#ffffff';
  ctx.arc(tip.x, tip.y, 5.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = fade;
  ctx.font = '500 20px "Geist Mono", ui-monospace, monospace';
  const label = `${symbol}  ${formatPrice(currency, price)}`;
  const width = ctx.measureText(label).width;
  const placeRight = tip.x + 22 + width < PLOT.x + PLOT.w - 8;
  const x = placeRight ? tip.x + 22 : tip.x - 22 - width;
  const y = Math.min(PLOT.y + PLOT.h - 8, Math.max(PLOT.y + 22, tip.y - 16));
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f4f7fb';
  ctx.fillText(label, x, y);
  ctx.globalAlpha = 1;
}

function drawMonths(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  dates: readonly string[],
  left: number,
  right: number,
): void {
  ctx.font = '400 16px "Geist Mono", ui-monospace, monospace';
  ctx.fillStyle = '#7d8696';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let lastX = -Infinity;
  let lastKey = '';
  const start = Math.max(0, Math.floor(left));
  const end = Math.min(dates.length - 1, Math.ceil(right));
  for (let i = start; i <= end; i += 1) {
    const iso = dates[i];
    if (!iso) continue;
    const key = iso.slice(0, 7);
    if (key === lastKey) continue;
    lastKey = key;
    const x = xAt(i, left, right);
    if (x < PLOT.x + 36 || x > PLOT.x + PLOT.w - 36 || x - lastX < 88) continue;
    lastX = x;
    ctx.fillText(shortMonth(iso), x, PLOT.y + PLOT.h + 16);
  }
}

function linePoints(
  prices: readonly number[],
  playhead: number,
  left: number,
  right: number,
  yMin: number,
  yMax: number,
): { x: number; y: number }[] {
  const last = Math.min(prices.length - 1, Math.max(0, playhead));
  const start = Math.max(0, Math.floor(left));
  const end = Math.min(prices.length - 1, Math.floor(last));
  const span = Math.max(1, end - start);
  const step = Math.max(1, Math.floor(span / 640));
  const points: { x: number; y: number }[] = [];
  for (let i = start; i <= end; i += step) {
    const value = prices[i];
    if (value === undefined) continue;
    pushPoint(points, xAt(i, left, right), yAt(value, yMin, yMax));
  }
  pushPoint(points, xAt(playhead, left, right), yAt(sample(prices, playhead), yMin, yMax));
  return points;
}

function pushPoint(points: { x: number; y: number }[], x: number, y: number): void {
  const previous = points[points.length - 1];
  if (previous && Math.hypot(previous.x - x, previous.y - y) < 0.75) return;
  points.push({ x, y });
}

function shortSymbol(symbol: string): string {
  return symbol.endsWith('.US') ? symbol.slice(0, -3) : symbol;
}

function revealProgress(frame: number): number {
  const drawEnd = FRAME_COUNT - HOLD_FRAMES;
  if (frame >= drawEnd) return 1;
  const u = frame / drawEnd;
  return 1 - (1 - u) ** 1.35;
}

function chooseWindow(count: number): number {
  const preferred = Math.round(count * 0.34);
  return Math.max(1, Math.min(count - 1, Math.max(preferred, Math.min(90, count - 1))));
}

function windowFor(playhead: number, count: number, size: number): { left: number; right: number } {
  const pad = size * 0.16;
  const maxRight = count - 1 + pad;
  let right = playhead + pad;
  let left = right - size;
  if (right > maxRight) {
    right = maxRight;
    left = right - size;
  }
  if (left < 0) {
    left = 0;
    right = Math.min(maxRight, size);
  }
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

function approach(current: number, target: number, expanding: boolean): number {
  const rate = expanding ? 0.11 : 0.035;
  return current + (target - current) * rate;
}

function sample(prices: readonly number[], index: number): number {
  const i0 = Math.max(0, Math.min(prices.length - 1, Math.floor(index)));
  const i1 = Math.min(prices.length - 1, i0 + 1);
  const span = index - i0;
  const a = prices[i0] ?? 0;
  const b = prices[i1] ?? a;
  return a + (b - a) * span;
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

function formatPrice(currency: string, value: number): string {
  const body = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = value < 0 ? '−' : '';
  if (currency === 'USD') return `${sign}$${body}`;
  if (currency === 'HKD') return `${sign}HK$${body}`;
  return `${sign}${body} ${currency}`.trim();
}

function formatSignedPrice(currency: string, value: number): string {
  const body = formatPrice(currency, Math.abs(value));
  if (value > 0) return `+${body}`;
  if (value < 0) return `−${body}`;
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

function compactNumber(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
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

function drawTabular(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
): void {
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

function trimText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}…`;
}

function roundRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
