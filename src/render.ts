import { percentChange } from '../shared/model';
import {
  activeCallout,
  damp,
  detectEvents,
  ESTABLISH_END,
  formatCompact,
  formatLongDate,
  formatMonthStamp,
  formatMonthYear,
  formatPercent,
  formatPrice,
  formatShortMonth,
  formatWhole,
  FRAME_COUNT,
  FPS,
  growthSoFar,
  hookPlate,
  maxDrawdownSoFar,
  placeCallouts,
  playheadSeries,
  rangeSoFar,
  slowIndexes,
  START_VALUE,
  yearBoundaries,
  yearChapter,
  zoomSeries,
  type VisibleCallout,
} from './insights';

export {
  ESTABLISH_END,
  FPS,
  FRAME_COUNT,
  HOOK_END,
  PLAY_END,
  REWIND_END,
} from './insights';

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
  zoom: Float64Array;
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
  value: number;
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

interface Piece {
  text: string;
  color: string;
  tabular?: boolean;
}

const WIDTH = 1920;
const HEIGHT = 1080;
let axisCount = 2;
const PANEL = { x: 48, y: 248, w: 1824, h: 744 };
const PLOT = { x: 168, y: 296, w: 1672, h: 632 };
const TIME_Y = 1024;
const UP = '#3DDC97';
const DOWN = '#FF5D6C';
const INK = '#f7f8fb';
const MUTED = '#9aa3b5';

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
  const open = prices[0] ?? 0;
  const smooth = gaussianSmooth(prices, count > 80 ? 4 : 1);
  const highIndex = extremeIndex(prices, 'high');
  const lowIndex = extremeIndex(prices, 'low');
  pinExtreme(smooth, prices, highIndex);
  pinExtreme(smooth, prices, lowIndex);

  const events = detectEvents(prices, dates, input.dividends ?? [], input.currency);
  const slow = slowIndexes(events);
  const reveal = playheadSeries(count, slow);
  const schedule = placeCallouts(events, reveal);
  const zoom = zoomSeries(schedule);
  const yMin = new Float64Array(FRAME_COUNT);
  const yMax = new Float64Array(FRAME_COUNT);
  const windowLeft = new Float64Array(FRAME_COUNT);
  const windowRight = new Float64Array(FRAME_COUNT);
  const full = fixedRange(prices, open);
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    windowLeft[frame] = 0;
    windowRight[frame] = count - 1;
    yMin[frame] = full.lo;
    yMax[frame] = full.hi;
  }
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
    yMin,
    yMax,
    windowLeft,
    windowRight,
    zoom,
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
  axisCount = animation.prices.length;
  const playhead = animation.reveal[index] ?? 0;
  const open = animation.prices[0] ?? 0;
  const price = sample(animation.prices, playhead);
  const value = priceToValue(price, open);
  const yMin = animation.yMin[index] ?? price;
  const yMax = animation.yMax[index] ?? price;
  const zoom = animation.zoom[index] ?? 1;
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
  drawHeader(ctx, animation, index, value, price, plate);
  drawCards(ctx, animation, endIndex, index);

  ctx.save();
  ctx.beginPath();
  ctx.rect(PLOT.x, PLOT.y, PLOT.w, PLOT.h);
  ctx.clip();
  const centerX = PLOT.x + PLOT.w / 2;
  const centerY = PLOT.y + PLOT.h / 2;
  ctx.translate(centerX, centerY);
  ctx.scale(zoom, zoom);
  ctx.translate(-centerX, -centerY);
  drawGrid(ctx, yMin, yMax, open);
  drawYearDividers(ctx, animation);
  const lineAlpha = 0.32 + 0.68 * (1 - plate);
  drawSeries(ctx, animation, playhead, yMin, yMax, lineAlpha);
  drawUpcoming(ctx, animation, index, playhead);
  drawStartLine(ctx, yAt(open, yMin, yMax));
  if (plate < 0.85 && animation.highIndex !== animation.lowIndex) {
    drawExtremeDot(ctx, animation, animation.highIndex, playhead, yMin, yMax);
    drawExtremeDot(ctx, animation, animation.lowIndex, playhead, yMin, yMax);
  }
  const points = collectPoints(animation, playhead, yMin, yMax);
  const tip = points[points.length - 1];
  if (tip && plate < 0.92) drawHeadDot(ctx, tip);
  ctx.restore();

  drawYLabels(ctx, yMin, yMax, open, animation.currency);
  drawStartLabel(ctx, animation.currency, yAt(open, yMin, yMax));
  drawXLabels(ctx, animation.dates);
  if (index >= ESTABLISH_END) drawYearLabel(ctx, animation, endIndex, index);
  drawCallout(ctx, animation, index);
  if (plate > 0.02) drawHook(ctx, animation, plate);
  drawTimebar(ctx, animation, playhead);
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawHeader(ctx: Ctx, animation: Animation, frame: number, value: number, price: number, plate: number): void {
  const title = `${shortSymbol(animation.symbol)} · ${animation.name}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 32px Geist, sans-serif';
  ctx.fillStyle = INK;
  ctx.fillText(trimText(ctx, title, 560), 48, 72);

  const heroAlpha = 1 - plate;
  if (heroAlpha > 0.02) {
    ctx.save();
    ctx.globalAlpha = heroAlpha;
    ctx.font = '600 104px Geist, sans-serif';
    ctx.fillStyle = INK;
    drawTabular(ctx, formatWhole(animation.currency, value), 48, 176);
    ctx.font = '500 24px Geist, sans-serif';
    const secondary = secondaryLine(animation, frame, value, price);
    drawPieces(ctx, secondary, 48, 228, 1500);
    ctx.restore();
  }
}

function secondaryLine(animation: Animation, frame: number, value: number, price: number): Piece[] {
  const date = animation.dates[Math.min(animation.dates.length - 1, Math.max(0, Math.round(animation.reveal[frame] ?? 0)))] ?? '';
  if (frame <= ESTABLISH_END) {
    return [{ text: formatLongDate(date), color: '#d5dbe6' }];
  }
  const open = animation.prices[0] ?? 0;
  const pct = open === 0 ? 0 : percentChange(price, open);
  const above = value >= START_VALUE - 0.5;
  const first = animation.dates[0] ?? date;
  return [
    { text: formatPercent(pct), color: above ? '#b6ffd8' : '#ffc7ce', tabular: true },
    { text: `  ·  ${formatMonthYear(first)} → ${formatMonthYear(date)}  ·  Share `, color: '#d5dbe6' },
    { text: formatPrice(animation.currency, price), color: INK, tabular: true },
  ];
}

function drawCards(ctx: Ctx, animation: Animation, endIndex: number, frame: number): void {
  const price = animation.prices[endIndex] ?? 0;
  const open = animation.prices[0] ?? price;
  const range = rangeSoFar(animation.prices, animation.dates, endIndex);
  const drawdown = maxDrawdownSoFar(animation.prices, animation.dates, endIndex);
  const growth = growthSoFar(open, price, animation.dates[0] ?? '', animation.dates[endIndex] ?? '');
  const value = priceToValue(price, open);
  const cards = [
    {
      title: 'RANGE · 5Y',
      value: formatPrice(animation.currency, range.high),
      color: UP,
      accent: UP,
      sub: [
        { text: 'HI ', color: MUTED },
        { text: formatPrice(animation.currency, range.high), color: UP, tabular: true },
        { text: ` · ${formatMonthStamp(range.highDate)}`, color: MUTED },
        { text: '   LO ', color: MUTED },
        { text: formatPrice(animation.currency, range.low), color: DOWN, tabular: true },
        { text: ` · ${formatMonthStamp(range.lowDate)}`, color: MUTED },
      ],
    },
    {
      title: 'MAX DRAWDOWN',
      value: formatPercent(drawdown.depth),
      color: drawdown.depth < -0.005 ? DOWN : MUTED,
      accent: drawdownAccent(drawdown.current),
      sub: [
        { text: formatPrice(animation.currency, drawdown.peak), color: '#d5dbe6', tabular: true },
        { text: ' → ', color: MUTED },
        { text: formatPrice(animation.currency, drawdown.trough), color: '#d5dbe6', tabular: true },
        { text: `  ·  ${formatMonthStamp(drawdown.peakDate)} → ${formatMonthStamp(drawdown.troughDate)}`, color: MUTED },
      ],
    },
    {
      title: 'CAGR',
      value: growth.annualized ? `${formatPercent(growth.rate)} / yr` : formatPercent(growth.rate),
      color: growth.rate >= 0 ? UP : DOWN,
      accent: growth.rate >= 0 ? UP : DOWN,
      sub: [
        { text: formatWhole(animation.currency, START_VALUE), color: '#d5dbe6', tabular: true },
        { text: ' → ', color: MUTED },
        { text: formatWhole(animation.currency, value), color: INK, tabular: true },
        { text: `  ·  ${growth.years.toFixed(1)} yrs`, color: MUTED },
      ],
    },
  ];
  cards.forEach((card, slot) => {
    drawCard(ctx, 664 + slot * 408, 40, 392, 176, damp(Math.max(0, frame - 6 - slot * 8) / FPS), card);
  });
}

function drawCard(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  appear: number,
  card: { title: string; value: string; color: string; accent: string; sub: Piece[] },
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
  ctx.fillRect(x, y + slide, w, 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '500 15px "Geist Mono", monospace';
  ctx.fillStyle = MUTED;
  fillTracked(ctx, card.title, x + 16, y + slide + 32, 1.1);
  ctx.font = '600 40px Geist, sans-serif';
  ctx.fillStyle = card.color;
  drawTabular(ctx, card.value, x + 16, y + slide + 92);
  ctx.font = '500 15px "Geist Mono", monospace';
  ctx.beginPath();
  ctx.rect(x + 12, y + slide + 108, w - 24, 60);
  ctx.clip();
  const lines = wrapPieces(ctx, card.sub, w - 32);
  lines.forEach((line, row) => drawPieces(ctx, line, x + 16, y + slide + 132 + row * 22, w - 32));
  ctx.restore();
}

function drawHook(ctx: Ctx, animation: Animation, alpha: number): void {
  const open = animation.prices[0] ?? 0;
  const end = animation.prices[animation.prices.length - 1] ?? open;
  const value = priceToValue(end, open);
  const pct = open === 0 ? 0 : percentChange(end, open);
  const above = value >= START_VALUE;
  const answer: Piece[] = [
    { text: formatWhole(animation.currency, START_VALUE), color: INK, tabular: true },
    { text: ' → ', color: MUTED },
    { text: formatWhole(animation.currency, value), color: INK, tabular: true },
  ];
  const detail: Piece[] = [
    { text: `in ${shortSymbol(animation.symbol)}  ·  `, color: '#d5dbe6' },
    { text: formatPercent(pct), color: above ? '#b6ffd8' : '#ffc7ce', tabular: true },
  ];
  const x = 48;
  const y = 96;
  const boxW = 600;
  const boxH = 200;
  const slide = (1 - damp(Math.min(1, alpha * 1.4))) * 16;
  ctx.save();
  ctx.globalAlpha = alpha;
  roundRect(ctx, x, y + slide, boxW, boxH, 16);
  ctx.fillStyle = 'rgba(7,8,11,0.88)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 48px Geist, sans-serif';
  drawPieces(ctx, answer, x + 28, y + slide + 88, boxW - 56);
  ctx.font = '500 28px Geist, sans-serif';
  drawPieces(ctx, detail, x + 28, y + slide + 144, boxW - 56);
  ctx.restore();
}

function drawSeries(
  ctx: Ctx,
  animation: Animation,
  playhead: number,
  yMin: number,
  yMax: number,
  alpha: number,
): void {
  const points = collectPoints(animation, playhead, yMin, yMax);
  const runs = splitRuns(points, START_VALUE);
  const startY = yAt(animation.prices[0] ?? 0, yMin, yMax);
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
  if (right <= left + 2) return;
  ctx.save();
  ctx.fillStyle = callout.tone === 'down' ? 'rgba(255,93,108,0.22)' : callout.tone === 'up' ? 'rgba(61,220,151,0.18)' : 'rgba(255,255,255,0.1)';
  ctx.fillRect(left, PLOT.y, right - left, PLOT.h);
  ctx.strokeStyle = callout.tone === 'down' ? DOWN : callout.tone === 'up' ? UP : 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(right, PLOT.y + 6);
  ctx.lineTo(right, PLOT.y + PLOT.h - 6);
  ctx.stroke();
  ctx.restore();
}

function drawYearDividers(ctx: Ctx, animation: Animation): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 8]);
  for (const index of yearBoundaries(animation.dates)) {
    if (index <= 0) continue;
    const x = xAt(index);
    ctx.beginPath();
    ctx.moveTo(x, PLOT.y);
    ctx.lineTo(x, PLOT.y + PLOT.h);
    ctx.stroke();
  }
  ctx.restore();
}

function drawYearLabel(ctx: Ctx, animation: Animation, endIndex: number, frame: number): void {
  const chapter = yearChapter(animation.prices, animation.dates, endIndex);
  const appear = damp(Math.max(0, frame - ESTABLISH_END) / FPS);
  if (appear <= 0.02 || !chapter.year) return;
  const percent = formatPercent(chapter.fraction);
  const label = `${chapter.year}`;
  ctx.save();
  ctx.globalAlpha = appear;
  ctx.font = '500 22px "Geist Mono", monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.fillText(label, PLOT.x + 16, PANEL.y + 26);
  const offset = ctx.measureText(`${label}  ·  `).width;
  ctx.fillStyle = MUTED;
  ctx.fillText('·', PLOT.x + 16 + ctx.measureText(label).width + 10, PANEL.y + 26);
  ctx.fillStyle = chapter.fraction >= 0 ? UP : DOWN;
  drawTabular(ctx, percent, PLOT.x + 16 + offset, PANEL.y + 26);
  ctx.restore();
}

function drawCallout(ctx: Ctx, animation: Animation, frame: number): void {
  const callout = activeCallout(animation.schedule, frame);
  if (!callout) return;
  const life = (frame - callout.startFrame) / FPS;
  const remain = (callout.endFrame - frame) / FPS;
  const appear = Math.min(damp(life, 16), damp(remain, 18));
  if (appear <= 0.02) return;
  ctx.save();
  ctx.globalAlpha = appear;
  ctx.font = '600 22px "Geist Mono", monospace';
  const text = callout.text;
  const width = Math.min(640, ctx.measureText(text).width + 36);
  const box = {
    x: Math.max(PLOT.x + 300, PLOT.x + PLOT.w - width - 16),
    y: PANEL.y + 6 + (1 - appear) * 8,
    w: width,
    h: 36,
  };
  roundRect(ctx, box.x, box.y, box.w, box.h, 10);
  ctx.fillStyle = 'rgba(7,8,11,0.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = callout.tone === 'down' ? DOWN : callout.tone === 'up' ? UP : 'rgba(255,255,255,0.55)';
  ctx.fillRect(box.x, box.y, 3, box.h);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.fillText(text, box.x + 16, box.y + box.h / 2);
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

function drawGrid(ctx: Ctx, yMin: number, yMax: number, open: number): void {
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.setLineDash([]);
  for (const tick of axisTicks(yMin, yMax, open)) {
    ctx.beginPath();
    ctx.moveTo(PLOT.x, tick.y);
    ctx.lineTo(PLOT.x + PLOT.w, tick.y);
    ctx.stroke();
  }
}

function drawYLabels(ctx: Ctx, yMin: number, yMax: number, open: number, currency: string): void {
  ctx.font = '500 20px "Geist Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#d5dbe6';
  for (const tick of axisTicks(yMin, yMax, open)) {
    ctx.fillText(formatCompact(currency, tick.value), PLOT.x - 12, tick.y);
  }
}

function axisTicks(yMin: number, yMax: number, open: number): { value: number; y: number }[] {
  const vMin = priceToValue(yMin, open);
  const vMax = priceToValue(yMax, open);
  const step = niceStep(vMax - vMin, 4);
  const values: number[] = [];
  if (step > 0) {
    const start = Math.ceil(vMin / step) * step;
    for (let value = start; value <= vMax + step * 0.01; value += step) values.push(value);
  }
  if (START_VALUE > vMin && START_VALUE < vMax && !values.some((value) => Math.abs(value - START_VALUE) < Math.max(step, 1) * 0.2)) {
    values.push(START_VALUE);
  }
  values.sort((a, b) => a - b);
  const placed: { value: number; y: number }[] = [];
  for (const value of values) {
    const y = yAt(valueToPrice(value, open), yMin, yMax);
    if (y < PLOT.y + 18 || y > PLOT.y + PLOT.h - 18) continue;
    const hit = placed.findIndex((tick) => Math.abs(tick.y - y) < 42);
    if (hit >= 0) {
      const existing = placed[hit];
      if (existing && Math.abs(value - START_VALUE) < Math.abs(existing.value - START_VALUE)) placed[hit] = { value, y };
      continue;
    }
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

function drawStartLine(ctx: Ctx, startY: number): void {
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

function drawStartLabel(ctx: Ctx, currency: string, startY: number): void {
  if (startY < PLOT.y + 8 || startY > PLOT.y + PLOT.h - 8) return;
  const text = `START ${formatWhole(currency, START_VALUE)}`;
  ctx.font = '600 18px "Geist Mono", monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  if (startY > PLOT.y + 36) {
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, PLOT.x + 12, startY - 8);
    return;
  }
  ctx.textBaseline = 'top';
  ctx.fillText(text, PLOT.x + 12, startY + 8);
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

function drawHeadDot(ctx: Ctx, tip: Point): void {
  ctx.beginPath();
  ctx.fillStyle = tip.value >= START_VALUE ? UP : DOWN;
  ctx.arc(tip.x, tip.y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = INK;
  ctx.arc(tip.x, tip.y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawExtremeDot(
  ctx: Ctx,
  animation: Animation,
  index: number,
  playhead: number,
  yMin: number,
  yMax: number,
): void {
  if (playhead < index) return;
  const price = animation.prices[index];
  if (price === undefined) return;
  ctx.beginPath();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.arc(xAt(index), yAt(price, yMin, yMax), 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawXLabels(ctx: Ctx, dates: readonly string[]): void {
  if (dates.length === 0) return;
  const lastIndex = dates.length - 1;
  ctx.font = '500 18px "Geist Mono", monospace';
  ctx.fillStyle = '#d5dbe6';
  ctx.textBaseline = 'top';
  const y = PLOT.y + PLOT.h + 16;
  const entries: { index: number; align: CanvasTextAlign }[] = [
    { index: 0, align: 'left' },
    { index: Math.round(lastIndex * 0.25), align: 'center' },
    { index: Math.round(lastIndex * 0.5), align: 'center' },
    { index: Math.round(lastIndex * 0.75), align: 'center' },
    { index: lastIndex, align: 'right' },
  ];
  const occupied: Box[] = [];
  for (const entry of entries) {
    const iso = dates[entry.index];
    if (!iso) continue;
    const text = formatShortMonth(iso);
    const width = ctx.measureText(text).width;
    const at = xAt(entry.index);
    ctx.textAlign = entry.align;
    const edge = entry.align === 'left' ? at : entry.align === 'right' ? at - width : at - width / 2;
    const box = { x: edge, y, w: width, h: 20 };
    if (occupied.some((item) => box.x < item.x + item.w + 16 && box.x + box.w > item.x - 16)) continue;
    ctx.fillText(text, entry.align === 'left' ? at : entry.align === 'right' ? Math.min(PLOT.x + PLOT.w, at) : at, y);
    occupied.push(box);
  }
}

function collectPoints(animation: Animation, playhead: number, yMin: number, yMax: number): Point[] {
  const open = animation.prices[0] ?? 0;
  const last = Math.min(animation.prices.length - 1, Math.max(0, playhead));
  const end = Math.min(animation.prices.length - 1, Math.floor(last));
  const step = Math.max(1, Math.floor(Math.max(1, end) / 480));
  const indexes: number[] = [];
  for (let i = 0; i <= end; i += step) indexes.push(i);
  if (animation.highIndex <= end) indexes.push(animation.highIndex);
  if (animation.lowIndex <= end) indexes.push(animation.lowIndex);
  for (const item of animation.schedule) {
    if (item.anchor <= end) indexes.push(item.anchor);
  }
  indexes.push(playhead);
  indexes.sort((a, b) => a - b);
  const points: Point[] = [];
  let previous = -Infinity;
  for (const index of indexes) {
    if (index - previous < 1e-4) continue;
    previous = index;
    const drawn = visualPrice(animation, index, playhead);
    points.push({ x: xAt(index), y: yAt(drawn, yMin, yMax), value: priceToValue(drawn, open) });
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

function fixedRange(prices: readonly number[], open: number): { lo: number; hi: number } {
  let min = prices[0] ?? open;
  let max = min;
  for (const price of prices) {
    if (price < min) min = price;
    if (price > max) max = price;
  }
  const span = Math.max(max - min, Math.abs(open) * 0.08, 1);
  let lo = Math.min(min, open) - span * 0.2;
  let hi = Math.max(max, open) + span * 0.3;
  if (lo < 0) lo = 0;
  if (lo >= min) lo = Math.max(0, min - span * 0.12);
  if (hi <= max) hi = max + span * 0.3;
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

function priceToValue(price: number, open: number): number {
  if (open === 0) return START_VALUE;
  return (price / open) * START_VALUE;
}

function valueToPrice(value: number, open: number): number {
  if (open === 0) return 0;
  return (value / START_VALUE) * open;
}

function xAt(index: number): number {
  const span = Math.max(1, axisCount - 1);
  return PLOT.x + (index / span) * PLOT.w;
}

function yAt(price: number, yMin: number, yMax: number): number {
  const span = Math.max(1e-6, yMax - yMin);
  return PLOT.y + PLOT.h - ((price - yMin) / span) * PLOT.h;
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
  const base = stripped || name.trim();
  if (base === base.toUpperCase()) return base.toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
  return base;
}

function shortSymbol(symbol: string): string {
  return symbol.endsWith('.US') ? symbol.slice(0, -3) : symbol;
}

function drawdownAccent(depth: number): string {
  const t = Math.max(0, Math.min(1, Math.abs(depth) / 0.5));
  const red = Math.round(92 + (255 - 92) * t);
  const green = Math.round(101 + (93 - 101) * t);
  const blue = Math.round(120 + (108 - 120) * t);
  return `rgb(${red}, ${green}, ${blue})`;
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

function drawPieces(ctx: Ctx, pieces: readonly Piece[], x: number, y: number, maxWidth: number): void {
  const fitted = fitPieces(ctx, pieces, maxWidth);
  let cursor = x;
  const base = ctx.fillStyle;
  for (const piece of fitted) {
    ctx.fillStyle = piece.color;
    if (piece.tabular) drawTabular(ctx, piece.text, cursor, y);
    else ctx.fillText(piece.text, cursor, y);
    cursor += ctx.measureText(piece.text).width;
  }
  ctx.fillStyle = base;
}

function wrapPieces(ctx: Ctx, pieces: readonly Piece[], maxWidth: number): Piece[][] {
  const lines: Piece[][] = [[]];
  for (const piece of pieces) {
    const line = lines[lines.length - 1] ?? [];
    const nextWidth = measurePieces(ctx, line) + ctx.measureText(piece.text).width;
    if (line.length > 0 && nextWidth > maxWidth && lines.length < 2) lines.push([piece]);
    else line.push(piece);
  }
  return lines;
}

function fitPieces(ctx: Ctx, pieces: readonly Piece[], maxWidth: number): Piece[] {
  if (measurePieces(ctx, pieces) <= maxWidth) return pieces.slice();
  const text = pieces.map((piece) => piece.text).join('');
  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) trimmed = trimmed.slice(0, -1);
  return [{ text: `${trimmed}…`, color: pieces[0]?.color ?? INK }];
}

function measurePieces(ctx: Ctx, pieces: readonly Piece[]): number {
  return pieces.reduce((sum, piece) => sum + ctx.measureText(piece.text).width, 0);
}

function fillTracked(ctx: Ctx, text: string, x: number, y: number, tracking: number): void {
  let cursor = x;
  for (const char of text) {
    ctx.fillText(char, cursor, y);
    cursor += ctx.measureText(char).width + tracking;
  }
}

function trimText(ctx: Ctx, text: string, maxWidth: number): string {
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

