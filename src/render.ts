import { percentChange } from '../shared/model';
import {
  activeCallout,
  damp,
  detectEvents,
  easeInOut,
  ESTABLISH_END,
  formatLongDate,
  formatMonthStamp,
  formatMonthYear,
  formatPercent,
  formatPrice,
  formatShortMonth,
  formatSignedPrice,
  growthSoFar,
  FRAME_COUNT,
  hookPlate,
  HOOK_END,
  maxDrawdownSoFar,
  placeCallouts,
  PLAY_END,
  playheadSeries,
  rangeSoFar,
  REWIND_END,
  slowIndexes,
  stepSpring,
  yearBoundaries,
  yearChapter,
  type VisibleCallout,
} from './insights';

export { ESTABLISH_END, FPS, FRAME_COUNT, HOOK_END, PLAY_END, REWIND_END } from './insights';

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
  logMix: Float64Array;
  schedule: VisibleCallout[];
  highIndex: number;
  lowIndex: number;
  yearsLabel: string;
  hookFrame: number;
  calloutFrame: number;
}

interface Point {
  x: number;
  y: number;
  price: number;
}

interface Run {
  above: boolean;
  points: Point[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ViewTarget {
  left: number;
  right: number;
  lo: number;
  hi: number;
}

const WIDTH = 1920;
const HEIGHT = 1080;
const PANEL = { x: 48, y: 308, w: 1824, h: 668 };
const PLOT = { x: 176, y: 340, w: 1664, h: 552 };
const TIME_Y = 1024;
const CARD_X = 680;
const CARD_W = 392;
const CARD_H = 168;
const CARD_GAP = 12;
const UP = '#3DDC97';
const DOWN = '#FF5D6C';
const INK = '#f7f8fb';
const MUTED = '#9aa3b5';

let viewLeft = 0;
let viewRight = 1;
let viewLo = 1;
let viewHi = 2;
let viewLog = 0;

export function buildAnimation(input: {
  displaySymbol: string;
  name: string;
  currency: string;
  bars: readonly { date: string; close: number }[];
  dividends?: readonly { date: string; amount: number }[];
}): Animation {
  const bars = input.bars
    .filter((bar) => Number.isFinite(bar.close))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (bars.length < 2) throw new Error('Need at least two closing prices');

  const prices = bars.map((bar) => bar.close);
  const dates = bars.map((bar) => bar.date);
  const count = prices.length;
  const smooth = gaussianSmooth(prices, count > 80 ? 4 : 1);
  const highIndex = extremeIndex(prices, 'high');
  const lowIndex = extremeIndex(prices, 'low');
  pinExtreme(smooth, prices, highIndex);
  pinExtreme(smooth, prices, lowIndex);

  const events = detectEvents(prices, dates, input.dividends ?? [], input.currency);
  const reveal = playheadSeries(count, slowIndexes(events));
  const schedule = placeCallouts(events, reveal);
  const view = buildView(prices, reveal, schedule);
  const featured =
    schedule.find((item) => item.kind === 'drawdown') ??
    schedule.find((item) => item.kind === 'down' || item.kind === 'up') ??
    schedule[0];

  return {
    symbol: input.displaySymbol,
    name: presentName(input.name),
    currency: input.currency,
    dates,
    prices,
    smooth,
    reveal,
    yMin: view.yMin,
    yMax: view.yMax,
    windowLeft: view.windowLeft,
    windowRight: view.windowRight,
    logMix: view.logMix,
    schedule,
    highIndex,
    lowIndex,
    yearsLabel: yearsPhrase(dates[0] ?? '', dates[dates.length - 1] ?? ''),
    hookFrame: 72,
    calloutFrame: featured ? Math.min(FRAME_COUNT - 1, featured.startFrame + 18) : Math.floor(FRAME_COUNT / 2),
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
  viewLeft = animation.windowLeft[index] ?? 0;
  viewRight = Math.max(viewLeft + 1e-3, animation.windowRight[index] ?? viewLeft + 1);
  viewLo = animation.yMin[index] ?? price;
  viewHi = animation.yMax[index] ?? Math.max(price, viewLo + 1);
  viewLog = animation.logMix[index] ?? 0;
  if (!(viewHi > viewLo)) viewHi = viewLo + 1;
  if (viewLog > 0 && viewLo <= 0) viewLo = Math.max(1e-4, Math.min(price, viewHi) * 0.2);
  const plate = hookPlate(index);
  const canvas = ctx.canvas;
  ctx.setTransform(canvas.width / WIDTH, 0, 0, canvas.height / HEIGHT, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  const background = ctx.createRadialGradient(980, 460, 80, 960, 560, 1100);
  background.addColorStop(0, '#141820');
  background.addColorStop(0.62, '#0c0e13');
  background.addColorStop(1, '#07080b');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  roundRect(ctx, PANEL.x, PANEL.y, PANEL.w, PANEL.h, 16);
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const endIndex = Math.min(animation.prices.length - 1, Math.max(0, Math.floor(playhead)));
  drawHeader(ctx, animation, index, price, plate);
  drawCards(ctx, animation, endIndex, index);

  ctx.save();
  ctx.beginPath();
  ctx.rect(PLOT.x, PLOT.y, PLOT.w, PLOT.h);
  ctx.clip();
  drawGrid(ctx);
  drawYearDividers(ctx, animation);
  const lineAlpha = 0.28 + 0.72 * (1 - plate);
  drawSeries(ctx, animation, playhead, open, lineAlpha);
  drawUpcoming(ctx, animation, index, playhead);
  drawStartLine(ctx, open);
  if (plate < 0.85) {
    drawExtremeDot(ctx, animation, animation.highIndex, playhead);
    drawExtremeDot(ctx, animation, animation.lowIndex, playhead);
  }
  const points = collectPoints(animation, playhead, open);
  const tip = points[points.length - 1];
  if (tip && plate < 0.92) drawHeadDot(ctx, tip, open);
  ctx.restore();

  drawYLabels(ctx, animation.currency);
  drawXLabels(ctx, animation);
  if (plate < 0.45) {
    drawStartLabel(ctx, animation.currency, open);
    drawExtremeLabel(ctx, animation, 'PEAK', animation.highIndex, playhead);
    drawExtremeLabel(ctx, animation, 'LOW', animation.lowIndex, playhead);
    if (tip) drawNowLabel(ctx, animation.currency, tip);
    drawCallout(ctx, animation, index, playhead, open);
  }
  if (viewLog > 0.55) drawLogLabel(ctx);
  if (index >= ESTABLISH_END) drawYearLabel(ctx, animation, endIndex);
  if (plate > 0.02) drawHook(ctx, animation, plate);
  drawTimebar(ctx, animation, playhead);
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawHeader(ctx: Ctx, animation: Animation, frame: number, price: number, plate: number): void {
  const ticker = shortSymbol(animation.symbol);
  const titleMax = CARD_X - 72;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 64px Geist, sans-serif';
  const tickerText = trimText(ctx, ticker, titleMax);
  ctx.fillStyle = INK;
  ctx.fillText(tickerText, 48, 78);
  const tickerWidth = ctx.measureText(tickerText).width;
  ctx.font = '500 64px Geist, sans-serif';
  ctx.fillStyle = '#d5dbe6';
  ctx.fillText(trimText(ctx, `  ${animation.name}`, Math.max(0, titleMax - tickerWidth)), 48 + tickerWidth, 78);

  ctx.font = '500 20px Geist, sans-serif';
  ctx.fillStyle = MUTED;
  ctx.fillText(`Share price  ·  ${animation.currency}`, 48, 116);

  const heroAlpha = 1 - plate;
  if (heroAlpha <= 0.02) return;
  ctx.save();
  ctx.globalAlpha = heroAlpha;
  ctx.font = '600 92px Geist, sans-serif';
  ctx.fillStyle = INK;
  drawTabular(ctx, formatPrice(animation.currency, price), 48, 214);
  const open = animation.prices[0] ?? price;
  const date = animation.dates[Math.min(animation.dates.length - 1, Math.max(0, Math.round(animation.reveal[frame] ?? 0)))] ?? '';
  if (frame < ESTABLISH_END) {
    ctx.font = '500 28px Geist, sans-serif';
    ctx.fillStyle = '#d5dbe6';
    ctx.fillText(formatLongDate(date), 48, 268);
  } else {
    const delta = price - open;
    const pct = open === 0 ? 0 : percentChange(price, open);
    const tone = delta >= 0 ? '#b6ffd8' : '#ffc7ce';
    ctx.font = '600 32px Geist, sans-serif';
    ctx.fillStyle = tone;
    drawTabular(ctx, `${formatSignedPrice(animation.currency, delta)}  ·  ${formatPercent(pct)}`, 48, 264);
    ctx.font = '500 24px Geist, sans-serif';
    ctx.fillStyle = '#d5dbe6';
    ctx.fillText(`${formatMonthYear(date)} since ${formatMonthYear(animation.dates[0] ?? date)}`, 48, 302);
  }
  ctx.restore();
}

function drawCards(ctx: Ctx, animation: Animation, endIndex: number, frame: number): void {
  const price = animation.prices[endIndex] ?? 0;
  const open = animation.prices[0] ?? price;
  const range = rangeSoFar(animation.prices, animation.dates, endIndex);
  const drawdown = maxDrawdownSoFar(animation.prices, animation.dates, endIndex);
  const growth = growthSoFar(open, price, animation.dates[0] ?? '', animation.dates[endIndex] ?? '');
  const cards = [
    {
      title: 'RANGE · 5Y',
      value: formatPrice(animation.currency, range.high),
      color: UP,
      accent: UP,
      foot: `LO ${formatAxis(animation.currency, range.low)} · ${formatMonthStamp(range.lowDate)}`,
    },
    {
      title: 'MAX DRAWDOWN',
      value: formatPercent(drawdown.depth),
      color: drawdown.depth < -0.005 ? DOWN : MUTED,
      accent: drawdownAccent(drawdown.current),
      foot: `${formatAxis(animation.currency, drawdown.peak)} → ${formatAxis(animation.currency, drawdown.trough)}`,
    },
    {
      title: 'CAGR',
      value: growth.annualized ? `${formatPercent(growth.rate)} / yr` : formatPercent(growth.rate),
      color: growth.rate >= 0 ? UP : DOWN,
      accent: growth.rate >= 0 ? UP : DOWN,
      foot: `${formatAxis(animation.currency, open)} → ${formatAxis(animation.currency, price)} · ${growth.years.toFixed(1)}y`,
    },
  ];
  cards.forEach((card, slot) => {
    drawCard(ctx, CARD_X + slot * (CARD_W + CARD_GAP), 28, CARD_W, CARD_H, damp(Math.max(0, frame - 6 - slot * 8) / 60), card);
  });
}

function drawCard(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  appear: number,
  card: { title: string; value: string; color: string; accent: string; foot: string },
): void {
  if (appear <= 0.01) return;
  const slide = (1 - appear) * 18;
  ctx.save();
  ctx.globalAlpha = appear;
  roundRect(ctx, x, y + slide, w, h, 12);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = card.accent;
  ctx.fillRect(x, y + slide, w, 3);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '500 16px "Geist Mono", monospace';
  ctx.fillStyle = MUTED;
  fillTracked(ctx, card.title, x + 20, y + slide + 32, 1.2);
  ctx.font = '600 40px Geist, sans-serif';
  ctx.fillStyle = card.color;
  drawTabular(ctx, card.value, x + 20, y + slide + 88);
  ctx.font = '500 28px "Geist Mono", monospace';
  ctx.fillStyle = '#d5dbe6';
  ctx.fillText(trimText(ctx, card.foot, w - 40), x + 20, y + slide + 140);
  ctx.restore();
}

function drawHook(ctx: Ctx, animation: Animation, alpha: number): void {
  const open = animation.prices[0] ?? 0;
  const end = animation.prices[animation.prices.length - 1] ?? open;
  const pct = open === 0 ? 0 : percentChange(end, open);
  const above = end >= open;
  const symbol = shortSymbol(animation.symbol);
  const line = `${symbol}  ·  ${formatPrice(animation.currency, open)} → ${formatPrice(animation.currency, end)}`;
  const detail = `${formatPercent(pct)} ${animation.yearsLabel}`;
  const x = 48;
  const y = 132;
  const boxW = 600;
  const boxH = 156;
  const slide = (1 - damp(Math.min(1, alpha * 1.4))) * 16;
  ctx.save();
  ctx.globalAlpha = alpha;
  roundRect(ctx, x, y + slide, boxW, boxH, 16);
  ctx.fillStyle = 'rgba(7,8,11,0.9)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 32px Geist, sans-serif';
  ctx.fillStyle = INK;
  drawTabular(ctx, trimText(ctx, line, boxW - 48), x + 24, y + slide + 64);
  ctx.font = '600 28px Geist, sans-serif';
  ctx.fillStyle = above ? '#b6ffd8' : '#ffc7ce';
  ctx.fillText(detail, x + 24, y + slide + 112);
  ctx.restore();
}

function drawSeries(ctx: Ctx, animation: Animation, playhead: number, open: number, alpha: number): void {
  const points = collectPoints(animation, playhead, open);
  const runs = splitRuns(points, open);
  const startY = yAt(open);
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const run of runs) drawArea(ctx, run, startY);
  for (const run of runs) drawRun(ctx, run);
  ctx.restore();
}

function drawUpcoming(ctx: Ctx, animation: Animation, frame: number, playhead: number): void {
  const callout = activeCallout(animation.schedule, frame);
  if (!callout || playhead >= callout.anchor - 0.25) return;
  const left = xAt(playhead);
  const right = xAt(callout.anchor);
  if (right <= left + 2 || right < PLOT.x || left > PLOT.x + PLOT.w) return;
  const from = Math.max(PLOT.x, Math.min(left, right));
  const to = Math.min(PLOT.x + PLOT.w, Math.max(left, right));
  ctx.save();
  ctx.fillStyle = callout.tone === 'down' ? 'rgba(255,93,108,0.14)' : callout.tone === 'up' ? 'rgba(61,220,151,0.12)' : 'rgba(255,255,255,0.08)';
  ctx.fillRect(from, PLOT.y, to - from, PLOT.h);
  ctx.fillStyle = callout.tone === 'down' ? DOWN : callout.tone === 'up' ? UP : INK;
  ctx.fillRect(to - 1.5, PLOT.y, 3, 22);
  ctx.restore();
}

function drawYearDividers(ctx: Ctx, animation: Animation): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 8]);
  for (const index of yearBoundaries(animation.dates)) {
    if (index <= viewLeft || index >= viewRight) continue;
    const x = xAt(index);
    ctx.beginPath();
    ctx.moveTo(x, PLOT.y);
    ctx.lineTo(x, PLOT.y + PLOT.h);
    ctx.stroke();
  }
  ctx.restore();
}

function drawYearLabel(ctx: Ctx, animation: Animation, endIndex: number): void {
  const chapter = yearChapter(animation.prices, animation.dates, endIndex);
  if (!chapter.year) return;
  ctx.save();
  ctx.font = '500 18px "Geist Mono", monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = MUTED;
  const label = `${chapter.year}`;
  ctx.fillText(label, 56, PLOT.y + PLOT.h + 48);
  const offset = ctx.measureText(`${label}  ·  `).width;
  ctx.fillStyle = chapter.fraction >= 0 ? UP : DOWN;
  drawTabular(ctx, formatPercent(chapter.fraction), 56 + offset, PLOT.y + PLOT.h + 48);
  ctx.restore();
}

function drawCallout(ctx: Ctx, animation: Animation, frame: number, playhead: number, open: number): void {
  const callout = activeCallout(animation.schedule, frame);
  if (!callout) return;
  const life = (frame - callout.startFrame) / 60;
  const remain = (callout.endFrame - frame) / 60;
  const appear = Math.min(damp(life, 16), damp(remain, 18));
  if (appear <= 0.02) return;
  const arrived = playhead >= callout.anchor - 0.25;
  const anchorX = Math.max(PLOT.x + 8, Math.min(PLOT.x + PLOT.w - 8, xAt(callout.anchor)));
  const anchorY = arrived ? yAt(sample(animation.prices, callout.anchor)) : PLOT.y + 28;
  ctx.save();
  ctx.globalAlpha = appear;
  ctx.font = '600 20px "Geist Mono", monospace';
  const width = Math.min(560, ctx.measureText(callout.text).width + 28);
  const height = 36;
  const preferBelow = anchorY < PLOT.y + PLOT.h * 0.42;
  let x = anchorX - width - 18;
  let y = preferBelow ? anchorY + 18 : anchorY - height - 18;
  if (x < PLOT.x + 8) x = Math.min(PLOT.x + PLOT.w - width - 8, anchorX + 18);
  if (y < PLOT.y + 8) y = PLOT.y + 8;
  if (y + height > PLOT.y + PLOT.h - 8) y = PLOT.y + PLOT.h - height - 8;
  ctx.strokeStyle = 'rgba(247,248,251,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(nearestEdge(x, y, width, height, anchorX, anchorY).x, nearestEdge(x, y, width, height, anchorX, anchorY).y);
  const edge = nearestEdge(x, y, width, height, anchorX, anchorY);
  ctx.moveTo(edge.x, edge.y);
  ctx.lineTo(anchorX, anchorY);
  ctx.stroke();
  roundRect(ctx, x, y + (1 - appear) * 8, width, height, 10);
  ctx.fillStyle = 'rgba(7,8,11,0.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = callout.tone === 'down' ? DOWN : callout.tone === 'up' ? UP : 'rgba(255,255,255,0.55)';
  ctx.fillRect(x, y + (1 - appear) * 8, 3, height);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.fillText(callout.text, x + 14, y + (1 - appear) * 8 + height / 2);
  if (arrived) {
    ctx.beginPath();
    ctx.fillStyle = priceTone(sample(animation.prices, callout.anchor), open);
    ctx.arc(anchorX, anchorY, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawTimebar(ctx: Ctx, animation: Animation, playhead: number): void {
  const count = Math.max(1, animation.prices.length - 1);
  const progress = Math.max(0, Math.min(1, playhead / count));
  const x = 48;
  const w = 1824;
  const y = TIME_Y;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, x, y, w, 4, 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(247,248,251,0.92)';
  roundRect(ctx, x, y, Math.max(4, w * progress), 4, 2);
  ctx.fill();
  const knob = x + w * progress;
  ctx.beginPath();
  ctx.fillStyle = INK;
  ctx.arc(knob, y + 2, 6, 0, Math.PI * 2);
  ctx.fill();

  const dateIndex = Math.min(animation.dates.length - 1, Math.max(0, Math.round(playhead)));
  const current = formatLongDate(animation.dates[dateIndex] ?? '');
  const start = formatMonthYear(animation.dates[0] ?? '');
  const end = formatMonthYear(animation.dates[animation.dates.length - 1] ?? '');
  ctx.font = '500 16px "Geist Mono", monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MUTED;
  if (progress > 0.12) {
    ctx.textAlign = 'left';
    ctx.fillText(start, x, y + 28);
  }
  if (progress < 0.88) {
    ctx.textAlign = 'right';
    ctx.fillText(end, x + w, y + 28);
  }
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  const labelX = Math.max(x + 80, Math.min(x + w - 80, knob));
  ctx.fillText(current, labelX, y - 12);
}

function drawGrid(ctx: Ctx): void {
  const linear = viewLog < 0.98 ? linearTicks() : [];
  const logged = viewLog > 0.02 ? logTicks() : [];
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  if (linear.length > 0) {
    ctx.globalAlpha = 1 - viewLog;
    for (const tick of linear) strokeGrid(ctx, tick.y);
  }
  if (logged.length > 0) {
    ctx.globalAlpha = viewLog;
    for (const tick of logged) strokeGrid(ctx, tick.y);
  }
  ctx.restore();
}

function strokeGrid(ctx: Ctx, y: number): void {
  ctx.beginPath();
  ctx.moveTo(PLOT.x, y);
  ctx.lineTo(PLOT.x + PLOT.w, y);
  ctx.stroke();
}

function drawYLabels(ctx: Ctx, currency: string): void {
  const ticks = viewLog > 0.5 ? logTicks() : linearTicks();
  ctx.font = '500 20px "Geist Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#d5dbe6';
  for (const tick of ticks) ctx.fillText(formatAxis(currency, tick.value), PLOT.x - 12, tick.y);
}

function drawLogLabel(ctx: Ctx): void {
  ctx.save();
  ctx.globalAlpha = Math.min(1, (viewLog - 0.55) / 0.3);
  ctx.font = '500 16px "Geist Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MUTED;
  ctx.fillText('log scale', PLOT.x + PLOT.w - 12, PLOT.y + 28);
  ctx.restore();
}

function linearTicks(): { value: number; y: number }[] {
  const step = niceStep(viewHi - viewLo, 4);
  const values: number[] = [];
  if (step > 0) {
    const start = Math.ceil(viewLo / step) * step;
    for (let value = start; value <= viewHi + step * 0.01; value += step) values.push(value);
  }
  return placeTicks(values);
}

function logTicks(): { value: number; y: number }[] {
  if (!(viewLo > 0) || !(viewHi > viewLo)) return [];
  const values: number[] = [];
  const startExp = Math.floor(Math.log10(viewLo));
  const endExp = Math.ceil(Math.log10(viewHi));
  for (let exp = startExp; exp <= endExp; exp += 1) {
    for (const base of [1, 2, 5]) {
      const value = base * 10 ** exp;
      if (value > viewLo && value < viewHi) values.push(value);
    }
  }
  return placeTicks(values);
}

function placeTicks(values: number[]): { value: number; y: number }[] {
  const placed: { value: number; y: number }[] = [];
  for (const value of values) {
    const y = yAt(value);
    if (y < PLOT.y + 16 || y > PLOT.y + PLOT.h - 16) continue;
    if (placed.some((tick) => Math.abs(tick.y - y) < 36)) continue;
    placed.push({ value, y });
  }
  return placed;
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

function drawStartLine(ctx: Ctx, open: number): void {
  const startY = yAt(open);
  if (startY < PLOT.y || startY > PLOT.y + PLOT.h) return;
  ctx.save();
  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PLOT.x, startY);
  ctx.lineTo(PLOT.x + PLOT.w, startY);
  ctx.stroke();
  ctx.restore();
}

function drawStartLabel(ctx: Ctx, currency: string, open: number): void {
  const startY = yAt(open);
  if (startY < PLOT.y + 8 || startY > PLOT.y + PLOT.h - 8) return;
  const text = `START ${formatPrice(currency, open)}`;
  ctx.font = '600 18px "Geist Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillStyle = INK;
  const y = startY > PLOT.y + 36 ? startY - 10 : startY + 22;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, PLOT.x + PLOT.w - 12, y);
}

function drawExtremeLabel(ctx: Ctx, animation: Animation, kind: 'PEAK' | 'LOW', index: number, playhead: number): void {
  if (playhead < index + 0.5 || Math.abs(playhead - index) < 3) return;
  if (index < viewLeft - 0.5 || index > viewRight + 0.5) return;
  const price = animation.prices[index];
  const date = animation.dates[index];
  if (price === undefined || !date) return;
  const x = xAt(index);
  const y = yAt(price);
  if (x < PLOT.x + 8 || x > PLOT.x + PLOT.w - 8 || y < PLOT.y + 8 || y > PLOT.y + PLOT.h - 8) return;
  const text = `${kind} ${formatPrice(animation.currency, price)} · ${formatMonthStamp(date)}`;
  ctx.font = '600 18px "Geist Mono", monospace';
  const width = ctx.measureText(text).width;
  let textX = x - width / 2;
  const above = kind === 'PEAK';
  let textY = above ? y - 18 : y + 28;
  if (textX < PLOT.x + 8) textX = PLOT.x + 8;
  if (textX + width > PLOT.x + PLOT.w - 8) textX = PLOT.x + PLOT.w - 8 - width;
  if (textY < PLOT.y + 18) textY = y + 28;
  if (textY > PLOT.y + PLOT.h - 8) textY = y - 18;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = kind === 'PEAK' ? UP : DOWN;
  ctx.fillText(text, textX, textY);
}

function drawNowLabel(ctx: Ctx, currency: string, tip: Point): void {
  const text = `NOW ${formatPrice(currency, tip.price)}`;
  ctx.font = '600 18px "Geist Mono", monospace';
  const width = ctx.measureText(text).width;
  const placeLeft = tip.x > PLOT.x + PLOT.w * 0.62;
  let x = placeLeft ? tip.x - width - 16 : tip.x + 16;
  let y = tip.y - 22;
  if (x < PLOT.x + 8) x = tip.x + 16;
  if (x + width > PLOT.x + PLOT.w - 8) x = tip.x - width - 16;
  if (y < PLOT.y + 18) y = tip.y + 28;
  if (y > PLOT.y + PLOT.h - 8) y = tip.y - 22;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
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
  ctx.fillStyle = run.above ? 'rgba(61,220,151,0.18)' : 'rgba(255,93,108,0.16)';
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

function drawHeadDot(ctx: Ctx, tip: Point, open: number): void {
  ctx.beginPath();
  ctx.fillStyle = priceTone(tip.price, open);
  ctx.arc(tip.x, tip.y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = INK;
  ctx.arc(tip.x, tip.y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawExtremeDot(ctx: Ctx, animation: Animation, index: number, playhead: number): void {
  if (playhead < index) return;
  const price = animation.prices[index];
  if (price === undefined) return;
  const x = xAt(index);
  const y = yAt(price);
  if (x < PLOT.x || x > PLOT.x + PLOT.w || y < PLOT.y || y > PLOT.y + PLOT.h) return;
  ctx.beginPath();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawXLabels(ctx: Ctx, animation: Animation): void {
  const dates = animation.dates;
  if (dates.length === 0) return;
  ctx.font = '500 18px "Geist Mono", monospace';
  ctx.fillStyle = '#d5dbe6';
  ctx.textBaseline = 'top';
  const y = PLOT.y + PLOT.h + 16;
  const fractions = [0, 0.25, 0.5, 0.75, 1];
  const occupied: Box[] = [];
  for (const fraction of fractions) {
    const index = viewLeft + (viewRight - viewLeft) * fraction;
    const clamped = Math.max(0, Math.min(dates.length - 1, Math.round(index)));
    const iso = dates[clamped];
    if (!iso) continue;
    const text = formatShortMonth(iso);
    const width = ctx.measureText(text).width;
    const at = xAt(clamped);
    const align: CanvasTextAlign = fraction === 0 ? 'left' : fraction === 1 ? 'right' : 'center';
    const edge = align === 'left' ? at : align === 'right' ? at - width : at - width / 2;
    const box = { x: edge, y, w: width, h: 20 };
    if (occupied.some((item) => box.x < item.x + item.w + 16 && box.x + box.w > item.x - 16)) continue;
    ctx.textAlign = align;
    ctx.fillText(text, align === 'right' ? Math.min(PLOT.x + PLOT.w, at) : at, y);
    occupied.push(box);
  }
}

function collectPoints(animation: Animation, playhead: number, open: number): Point[] {
  const last = Math.min(animation.prices.length - 1, Math.max(0, playhead));
  const start = Math.max(0, Math.floor(viewLeft));
  const end = Math.min(animation.prices.length - 1, Math.floor(last));
  const span = Math.max(1, end - start);
  const step = Math.max(1, Math.floor(span / 480));
  const indexes: number[] = [];
  for (let i = start; i <= end; i += step) indexes.push(i);
  if (animation.highIndex >= start && animation.highIndex <= end) indexes.push(animation.highIndex);
  if (animation.lowIndex >= start && animation.lowIndex <= end) indexes.push(animation.lowIndex);
  for (const item of animation.schedule) {
    if (item.anchor >= start && item.anchor <= end) indexes.push(item.anchor);
  }
  indexes.push(playhead);
  indexes.sort((a, b) => a - b);
  const points: Point[] = [];
  let previous = -Infinity;
  for (const index of indexes) {
    if (index - previous < 1e-4) continue;
    previous = index;
    const drawn = visualPrice(animation, index, playhead);
    points.push({ x: xAt(index), y: yAt(drawn), price: drawn || open });
  }
  return points;
}

function splitRuns(points: readonly Point[], open: number): Run[] {
  const first = points[0];
  if (!first) return [];
  const runs: Run[] = [];
  let batch: Point[] = [first];
  let above = first.price >= open;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const point = points[i];
    if (!prev || !point) continue;
    const prevAbove = prev.price >= open;
    const pointAbove = point.price >= open;
    if (prevAbove !== pointAbove && point.price !== prev.price) {
      const t = (open - prev.price) / (point.price - prev.price);
      const mid: Point = {
        x: prev.x + (point.x - prev.x) * t,
        y: prev.y + (point.y - prev.y) * t,
        price: open,
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
    ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
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

function buildView(prices: readonly number[], reveal: Float64Array, schedule: readonly VisibleCallout[]) {
  const count = prices.length;
  const size = chooseWindow(count);
  const full = fullDomain(prices);
  const yMin = new Float64Array(FRAME_COUNT);
  const yMax = new Float64Array(FRAME_COUNT);
  const windowLeft = new Float64Array(FRAME_COUNT);
  const windowRight = new Float64Array(FRAME_COUNT);
  const logMix = new Float64Array(FRAME_COUNT);
  const start = viewTarget(prices, 0, count, size, null);
  let left = start.left;
  let right = start.right;
  let lo = start.lo;
  let hi = start.hi;
  let velocityLeft = 0;
  let velocityRight = 0;
  let velocityLo = 0;
  let velocityHi = 0;
  const playLeft = new Float64Array(FRAME_COUNT);
  const playRight = new Float64Array(FRAME_COUNT);
  const playLo = new Float64Array(FRAME_COUNT);
  const playHi = new Float64Array(FRAME_COUNT);

  for (let frame = ESTABLISH_END; frame < PLAY_END; frame += 1) {
    const playhead = reveal[frame] ?? 0;
    const callout = schedule.find((item) => frame >= item.startFrame && frame < item.endFrame) ?? null;
    const target = viewTarget(prices, playhead, count, size, callout);
    const stepLeft = stepSpring(left, velocityLeft, target.left, 1 / 60, 5.5);
    const stepRight = stepSpring(right, velocityRight, target.right, 1 / 60, 5.5);
    left = stepLeft.value;
    velocityLeft = stepLeft.velocity;
    right = stepRight.value;
    velocityRight = stepRight.velocity;
    if (playhead > right) {
      left += playhead - right;
      right = playhead;
      velocityRight = 0;
    }
    if (left < 0) {
      right -= left;
      left = 0;
      velocityLeft = 0;
    }
    if (right > count - 1) {
      left = Math.max(0, left - (right - (count - 1)));
      right = count - 1;
      velocityRight = 0;
    }
    if (right < left + 1) right = Math.min(count - 1, left + 1);
    const raw = revealedRange(prices, left, playhead);
    const padded = padRange(raw.min, raw.max);
    if (raw.min < lo) {
      lo = raw.min;
      velocityLo = 0;
    }
    if (raw.max > hi) {
      hi = raw.max;
      velocityHi = 0;
    }
    const stepLo = stepSpring(lo, velocityLo, padded.lo, 1 / 60, padded.lo < lo ? 9 : 3.5);
    const stepHi = stepSpring(hi, velocityHi, padded.hi, 1 / 60, padded.hi > hi ? 9 : 3.5);
    lo = stepLo.value;
    velocityLo = stepLo.velocity;
    hi = stepHi.value;
    velocityHi = stepHi.velocity;
    if (raw.min < lo) lo = raw.min;
    if (raw.max > hi) hi = raw.max;
    if (!(hi > lo)) hi = lo + 1;
    playLeft[frame] = left;
    playRight[frame] = right;
    playLo[frame] = lo;
    playHi[frame] = hi;
  }

  const fromLeft = playLeft[PLAY_END - 1] ?? start.left;
  const fromRight = playRight[PLAY_END - 1] ?? start.right;
  let pullLo = playLo[PLAY_END - 1] ?? start.lo;
  let pullHi = playHi[PLAY_END - 1] ?? start.hi;
  let pullVelocityLo = 0;
  let pullVelocityHi = 0;
  const pullSpan = Math.max(1, FRAME_COUNT - PLAY_END);

  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    if (frame < HOOK_END) {
      windowLeft[frame] = 0;
      windowRight[frame] = Math.max(1, count - 1);
      yMin[frame] = full.lo;
      yMax[frame] = full.hi;
      logMix[frame] = full.log;
      continue;
    }
    if (frame < REWIND_END) {
      const unit = easeInOut((frame - HOOK_END) / Math.max(1, REWIND_END - HOOK_END));
      const playhead = reveal[frame] ?? 0;
      const local = viewTarget(prices, playhead, count, size, null);
      let nextLeft = lerp(0, local.left, unit);
      let nextRight = lerp(count - 1, local.right, unit);
      if (nextRight < playhead) nextRight = playhead;
      if (nextLeft > playhead) nextLeft = Math.max(0, playhead);
      if (nextRight < nextLeft + 1) nextRight = nextLeft + 1;
      const raw = revealedRange(prices, nextLeft, playhead);
      const fitted = padRange(raw.min, raw.max);
      windowLeft[frame] = nextLeft;
      windowRight[frame] = Math.min(count - 1, nextRight);
      yMin[frame] = Math.min(lerp(full.lo, local.lo, unit), fitted.lo, raw.min);
      yMax[frame] = Math.max(lerp(full.hi, local.hi, unit), fitted.hi, raw.max);
      logMix[frame] = full.log * (1 - unit);
      continue;
    }
    if (frame < ESTABLISH_END) {
      windowLeft[frame] = start.left;
      windowRight[frame] = start.right;
      yMin[frame] = start.lo;
      yMax[frame] = start.hi;
      logMix[frame] = 0;
      continue;
    }
    if (frame < PLAY_END) {
      windowLeft[frame] = playLeft[frame] ?? start.left;
      windowRight[frame] = playRight[frame] ?? start.right;
      yMin[frame] = playLo[frame] ?? start.lo;
      yMax[frame] = playHi[frame] ?? start.hi;
      logMix[frame] = 0;
      continue;
    }
    const unit = easeInOut((frame - (PLAY_END - 1)) / pullSpan);
    const nextLeft = lerp(fromLeft, 0, unit);
    const nextRight = lerp(fromRight, count - 1, unit);
    const raw = revealedRange(prices, nextLeft, count - 1);
    const targetLo = Math.min(lerp(playLo[PLAY_END - 1] ?? start.lo, full.lo, unit), raw.min);
    const targetHi = Math.max(lerp(playHi[PLAY_END - 1] ?? start.hi, full.hi, unit), raw.max);
    const stepLo = stepSpring(pullLo, pullVelocityLo, targetLo, 1 / 60, 8);
    const stepHi = stepSpring(pullHi, pullVelocityHi, targetHi, 1 / 60, 8);
    pullLo = Math.min(stepLo.value, raw.min);
    pullHi = Math.max(stepHi.value, raw.max);
    pullVelocityLo = stepLo.velocity;
    pullVelocityHi = stepHi.velocity;
    const last = frame === FRAME_COUNT - 1;
    windowLeft[frame] = last ? 0 : nextLeft;
    windowRight[frame] = last ? Math.max(1, count - 1) : nextRight;
    yMin[frame] = last ? full.lo : pullLo;
    yMax[frame] = last ? full.hi : pullHi;
    logMix[frame] = full.log * (last ? 1 : unit);
  }

  return { yMin, yMax, windowLeft, windowRight, logMix };
}

function chooseWindow(count: number): number {
  const preferred = Math.round(count * 0.28);
  return Math.max(1, Math.min(count - 1, Math.max(preferred, Math.min(80, count - 1))));
}

function viewTarget(
  prices: readonly number[],
  playhead: number,
  count: number,
  size: number,
  callout: VisibleCallout | null,
): ViewTarget {
  let right = playhead;
  if (callout && callout.anchor > playhead + 0.5) {
    const limit = playhead + Math.max(6, size * 0.18);
    right = Math.min(count - 1, Math.max(playhead, Math.min(callout.anchor, limit)));
  }
  const left = Math.max(0, right - size);
  if (right < left + 1) right = Math.min(count - 1, left + 1);
  const raw = revealedRange(prices, left, playhead);
  const padded = padRange(raw.min, raw.max);
  return { left, right, lo: padded.lo, hi: padded.hi };
}

function revealedRange(prices: readonly number[], left: number, playhead: number): { min: number; max: number } {
  const start = Math.max(0, Math.floor(left));
  const end = Math.min(prices.length - 1, Math.max(start, Math.ceil(playhead)));
  let min = sample(prices, Math.max(0, Math.min(prices.length - 1, playhead)));
  let max = min;
  for (let i = start; i <= end; i += 1) {
    const value = prices[i];
    if (value === undefined) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function padRange(min: number, max: number): { lo: number; hi: number } {
  const span = Math.max(max - min, Math.abs(max) * 0.08, 0.4);
  const pad = span * 0.22;
  const lo = Math.max(0, min - pad);
  const hi = Math.max(max + pad, lo + span);
  return { lo, hi };
}

function fullDomain(prices: readonly number[]): { lo: number; hi: number; log: number } {
  let min = prices[0] ?? 1;
  let max = min;
  for (const price of prices) {
    if (price < min) min = price;
    if (price > max) max = price;
  }
  const safeMin = Math.max(min, 1e-4);
  if (safeMin > 0 && max / safeMin > 5) {
    const logMin = Math.log(safeMin);
    const logMax = Math.log(Math.max(max, safeMin * 1.01));
    const pad = Math.max(0.06, (logMax - logMin) * 0.14);
    return { lo: Math.exp(logMin - pad), hi: Math.exp(logMax + pad), log: 1 };
  }
  const padded = padRange(min, max);
  return { lo: padded.lo, hi: padded.hi, log: 0 };
}

function lerp(from: number, to: number, unit: number): number {
  return from + (to - from) * unit;
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
    return weight === 0 ? (values[index] ?? 0) : acc / weight;
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

function xAt(index: number): number {
  const span = Math.max(1e-6, viewRight - viewLeft);
  const inset = 28;
  return PLOT.x + inset + ((index - viewLeft) / span) * (PLOT.w - inset * 2);
}

function yAt(price: number): number {
  let unit: number;
  if (viewLog > 0.001 && viewLo > 0 && viewHi > viewLo && price > 0) {
    const linear = (price - viewLo) / (viewHi - viewLo);
    const logged = (Math.log(price) - Math.log(viewLo)) / (Math.log(viewHi) - Math.log(viewLo));
    unit = linear * (1 - viewLog) + logged * viewLog;
  } else {
    unit = (price - viewLo) / Math.max(1e-6, viewHi - viewLo);
  }
  return PLOT.y + PLOT.h - unit * PLOT.h;
}

function clampFrame(frame: number): number {
  return Math.max(0, Math.min(FRAME_COUNT - 1, Math.floor(frame)));
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
  return stripped || name.trim();
}

function shortSymbol(symbol: string): string {
  return symbol.endsWith('.US') ? symbol.slice(0, -3) : symbol;
}

function priceTone(price: number, open: number): string {
  return price >= open ? UP : DOWN;
}

function drawdownAccent(depth: number): string {
  const t = Math.max(0, Math.min(1, Math.abs(depth) / 0.5));
  const red = Math.round(92 + (255 - 92) * t);
  const green = Math.round(101 + (93 - 101) * t);
  const blue = Math.round(120 + (108 - 120) * t);
  return `rgb(${red}, ${green}, ${blue})`;
}

function formatAxis(currency: string, value: number): string {
  const abs = Math.abs(value);
  const prefix = currency === 'USD' ? '$' : currency === 'HKD' ? 'HK$' : '';
  const suffix = prefix ? '' : ` ${currency}`;
  const sign = value < -0.000001 ? '−' : '';
  let body: string;
  if (abs >= 1000) {
    const scaled = abs / 1000;
    const digits = scaled >= 100 || Math.abs(scaled - Math.round(scaled)) < 0.05 ? 0 : 1;
    body = `${scaled.toFixed(digits)}k`;
  } else if (abs >= 100 || Math.abs(abs - Math.round(abs)) < 0.05) {
    body = Math.round(abs).toLocaleString('en-US');
  } else if (abs >= 10) {
    body = abs.toFixed(1);
  } else {
    body = abs.toFixed(2);
  }
  return `${sign}${prefix}${body}${suffix}`;
}

function nearestEdge(x: number, y: number, w: number, h: number, ax: number, ay: number): { x: number; y: number } {
  const cx = Math.max(x, Math.min(ax, x + w));
  const cy = Math.max(y, Math.min(ay, y + h));
  if (cx !== ax && cy !== ay) return { x: cx, y: cy };
  if (Math.abs(ax - x) < Math.abs(ax - (x + w))) return { x, y: Math.max(y, Math.min(ay, y + h)) };
  return { x: x + w, y: Math.max(y, Math.min(ay, y + h)) };
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

function fillTracked(ctx: Ctx, text: string, x: number, y: number, tracking: number): void {
  let cursor = x;
  for (const char of text) {
    ctx.fillText(char, cursor, y);
    cursor += ctx.measureText(char).width + tracking;
  }
}

function trimText(ctx: Ctx, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) trimmed = trimmed.slice(0, -1);
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
