import { percentChange } from '../shared/model';
import {
  activeCallout,
  damp,
  detectEvents,
  drawdownCalloutText,
  easeInOut,
  ESTABLISH_END,
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
const PANEL = { x: 48, y: 320, w: 1824, h: 708 };
const PLOT = { x: 214, y: 348, w: 1624, h: 628 };
const CARD_X = 680;
const CARD_W = 392;
const CARD_H = 236;
const RIGHT_PAD = 0.09;
const CARD_GAP = 12;
const UP = '#3DDC97';
const DOWN = '#FF5D6C';
const INK = '#f7f8fb';
const MUTED = '#9aa3b5';

let viewLeft = 0;
let viewRight = 1;
let viewLo = 1;
let viewHi = 2;

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

export interface FrameReading {
  price: number;
  high: number;
  low: number;
  lowDate: string;
  drop: number;
  dropPeak: number;
  dropTrough: number;
  cagrTo: number;
  calloutDrop: number | null;
  calloutText: string | null;
}

/** Hero, cards, the line head, and the drawdown callout all read this one snapshot. */
export function frameReading(animation: Animation, frame: number): FrameReading {
  const index = clampFrame(frame);
  const playhead = animation.reveal[index] ?? 0;
  const path = revealedPath(animation.prices, animation.dates, playhead);
  const end = path.prices.length - 1;
  const price = path.prices[end] ?? 0;
  const range = rangeSoFar(path.prices, path.dates, end);
  const drawdown = maxDrawdownSoFar(path.prices, path.dates, end);
  const callout = activeCallout(animation.schedule, index);
  const calloutDrop = callout?.kind === 'drawdown' ? drawdown.depth : null;
  return {
    price,
    high: range.high,
    low: range.low,
    lowDate: range.lowDate,
    drop: drawdown.depth,
    dropPeak: drawdown.peak,
    dropTrough: drawdown.trough,
    cagrTo: price,
    calloutDrop,
    calloutText: calloutDrop === null ? null : drawdownCalloutText(drawdown.depth, drawdown.peakDate, drawdown.troughDate),
  };
}

export function priceAt(animation: Animation, frame: number): number {
  return frameReading(animation, frame).price;
}

export function drawFrame(ctx: Ctx, animation: Animation, frame: number): void {
  const index = clampFrame(frame);
  const playhead = animation.reveal[index] ?? 0;
  const open = animation.prices[0] ?? 0;
  const reading = frameReading(animation, index);
  const price = reading.price;
  viewLeft = animation.windowLeft[index] ?? 0;
  viewRight = Math.max(viewLeft + 1e-3, animation.windowRight[index] ?? viewLeft + 1);
  viewLo = animation.yMin[index] ?? price;
  viewHi = animation.yMax[index] ?? Math.max(price, viewLo + 1);
  if (!(viewHi > viewLo)) viewHi = viewLo + 1;
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

  drawHeader(ctx, animation, index, price, plate);
  drawCards(ctx, animation, reading, index);

  ctx.save();
  ctx.beginPath();
  ctx.rect(PLOT.x, PLOT.y, PLOT.w, PLOT.h);
  ctx.clip();
  drawGrid(ctx);
  drawYearDividers(ctx, animation);
  const lineAlpha = 0.28 + 0.72 * (1 - plate);
  drawSeries(ctx, animation, playhead, open, price, lineAlpha);
  drawStartLine(ctx, open);
  if (plate < 0.85) {
    drawExtremeDot(ctx, animation, animation.highIndex, playhead);
    drawExtremeDot(ctx, animation, animation.lowIndex, playhead);
  }
  const points = collectPoints(animation, playhead, open, price);
  const tip = points[points.length - 1];
  if (tip) drawHeadDot(ctx, tip, open);
  ctx.restore();

  drawYLabels(ctx, animation.currency);
  drawXLabels(ctx, animation);
  if (plate < 0.45) drawAnnotations(ctx, animation, index, playhead, open, tip, reading);
  drawSource(ctx);
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
  ctx.fillText(`Share price  ·  ${animation.currency}`, 48, 112);

  const open = animation.prices[0] ?? price;
  const end = animation.prices[animation.prices.length - 1] ?? open;
  const date = animation.dates[Math.min(animation.dates.length - 1, Math.max(0, Math.round(animation.reveal[frame] ?? 0)))] ?? '';
  ctx.font = '600 92px Geist, sans-serif';
  ctx.fillStyle = INK;
  drawTabular(ctx, formatPrice(animation.currency, price), 48, 206);

  const delta = price - open;
  const pct = open === 0 ? 0 : percentChange(price, open);
  drawDeltaPill(ctx, `${formatSignedPrice(animation.currency, delta)}  ·  ${formatPercent(pct)}`, 48, 262, delta >= 0);

  const answerPct = open === 0 ? 0 : percentChange(end, open);
  const answer = `${ticker} · ${formatPrice(animation.currency, open)} → ${formatPrice(animation.currency, end)} · ${formatPercent(answerPct)} ${animation.yearsLabel}`;
  const asOf = `${formatMonthYear(date)} since ${formatMonthYear(animation.dates[0] ?? date)}`;
  ctx.font = '500 24px Geist, sans-serif';
  ctx.fillStyle = '#d5dbe6';
  ctx.textAlign = 'left';
  if (plate > 0.02) {
    ctx.save();
    ctx.globalAlpha = plate;
    ctx.fillText(fitSubtitle(ctx, answer, WIDTH - 96), 48, 308);
    ctx.restore();
  }
  if (plate < 0.98) {
    ctx.save();
    ctx.globalAlpha = 1 - plate;
    ctx.fillText(fitSubtitle(ctx, asOf, WIDTH - 96), 48, 308);
    ctx.restore();
  }
}

function drawCards(ctx: Ctx, animation: Animation, reading: FrameReading, frame: number): void {
  const playhead = animation.reveal[frame] ?? 0;
  const endIndex = Math.min(animation.dates.length - 1, Math.max(0, Math.floor(playhead)));
  const price = reading.price;
  const open = animation.prices[0] ?? price;
  const growth = growthSoFar(open, price, animation.dates[0] ?? '', animation.dates[endIndex] ?? '');
  const cards = [
    {
      title: `HIGH · ${windowTag(animation.dates[0] ?? '', animation.dates[endIndex] ?? '')}`,
      value: formatPrice(animation.currency, reading.high),
      color: UP,
      accent: UP,
      foot: `Low ${formatPrice(animation.currency, reading.low)} · ${formatMonthStamp(reading.lowDate)}`,
    },
    {
      title: 'MAX DROP',
      value: formatPercent(reading.drop),
      color: reading.drop < -0.005 ? DOWN : MUTED,
      accent: drawdownAccent(reading.drop),
      foot: `${formatPrice(animation.currency, reading.dropPeak)} → ${formatPrice(animation.currency, reading.dropTrough)}`,
    },
    {
      title: 'CAGR',
      value: growth.annualized ? `${formatPercent(growth.rate)}/yr` : formatPercent(growth.rate),
      color: growth.rate >= 0 ? UP : DOWN,
      accent: growth.rate >= 0 ? UP : DOWN,
      foot: `${formatPrice(animation.currency, open)} → ${formatPrice(animation.currency, reading.cagrTo)} · ${growth.years.toFixed(1)}y`,
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
  drawTabular(ctx, fitValue(ctx, card.value, w - 40), x + 20, y + slide + 92);
  ctx.font = '500 33px "Geist Mono", monospace';
  ctx.fillStyle = '#d5dbe6';
  const lines = wrapFoot(ctx, card.foot, w - 40);
  lines.forEach((line, lineIndex) => {
    ctx.fillText(line, x + 20, y + slide + 148 + lineIndex * 36);
  });
  ctx.restore();
}

function drawDeltaPill(ctx: Ctx, text: string, x: number, baseline: number, up: boolean): void {
  ctx.font = '600 28px Geist, sans-serif';
  const width = measureTabular(ctx, text) + 32;
  const height = 46;
  const top = baseline - 32;
  ctx.save();
  roundRect(ctx, x, top, width, height, 23);
  ctx.fillStyle = up ? 'rgba(61,220,151,0.18)' : 'rgba(255,93,108,0.2)';
  ctx.fill();
  ctx.strokeStyle = up ? 'rgba(61,220,151,0.7)' : 'rgba(255,93,108,0.75)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = up ? '#b6ffd8' : '#ffc7ce';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  drawTabular(ctx, text, x + 16, baseline);
  ctx.restore();
}

function drawSource(ctx: Ctx): void {
  ctx.save();
  ctx.font = '500 16px Geist, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#d5dbe6';
  ctx.fillText('Data: Yahoo Finance', WIDTH - 48, 1064);
  ctx.restore();
}

function drawSeries(ctx: Ctx, animation: Animation, playhead: number, open: number, price: number, alpha: number): void {
  const points = collectPoints(animation, playhead, open, price);
  const runs = splitRuns(points, open);
  const startY = yAt(open);
  ctx.save();
  for (const run of runs) drawArea(ctx, run, startY, alpha);
  for (const run of runs) drawRun(ctx, run, alpha);
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

type MarkKind = 'now' | 'peak' | 'low' | 'start' | 'callout';
type SlotSide = 'above' | 'below' | 'left' | 'right' | 'aboveLeft' | 'aboveRight' | 'belowLeft' | 'belowRight';

interface Mark {
  kind: MarkKind;
  text: string;
  ax: number;
  ay: number;
  color: string;
  accent: string | null;
  boxed: boolean;
  alpha: number;
}

interface PlacedMark extends Mark {
  box: Box;
}

const LABEL_FONT = '600 18px "Geist Mono", monospace';
const CALLOUT_FONT = '600 20px "Geist Mono", monospace';

function drawAnnotations(
  ctx: Ctx,
  animation: Animation,
  frame: number,
  playhead: number,
  open: number,
  tip: Point | undefined,
  reading: FrameReading,
): void {
  const marks = collectMarks(animation, frame, playhead, open, tip, reading);
  const placed: PlacedMark[] = [];
  ctx.save();
  ctx.setLineDash([]);
  for (const mark of marks) {
    const samePoint =
      mark.kind !== 'callout' &&
      mark.kind !== 'start' &&
      placed.some((item) => item.kind !== 'callout' && Math.hypot(item.ax - mark.ax, item.ay - mark.ay) < 16);
    if (samePoint) continue;
    const placedMark = mark.kind === 'start' ? placeStart(ctx, mark, placed) : placeNear(ctx, mark, placed);
    if (!placedMark) continue;
    placed.push(placedMark);
  }
  for (const mark of placed) drawLeader(ctx, mark);
  for (const mark of placed) drawMark(ctx, mark);
  ctx.restore();
}

function collectMarks(
  animation: Animation,
  frame: number,
  playhead: number,
  open: number,
  tip: Point | undefined,
  reading: FrameReading,
): Mark[] {
  const marks: Mark[] = [];
  if (tip && pointInside(tip.x, tip.y)) {
    marks.push({
      kind: 'now',
      text: `NOW ${formatPrice(animation.currency, reading.price)}`,
      ax: tip.x,
      ay: tip.y,
      color: INK,
      accent: null,
      boxed: false,
      alpha: 1,
    });
  }
  pushExtreme(marks, animation, 'peak', animation.highIndex, playhead);
  pushExtreme(marks, animation, 'low', animation.lowIndex, playhead);
  const startY = yAt(open);
  if (startY >= PLOT.y + 8 && startY <= PLOT.y + PLOT.h - 8) {
    marks.push({
      kind: 'start',
      text: `START ${formatPrice(animation.currency, open)}`,
      ax: PLOT.x + PLOT.w - 10,
      ay: startY,
      color: INK,
      accent: null,
      boxed: false,
      alpha: 1,
    });
  }
  const callout = activeCallout(animation.schedule, frame);
  if (callout) {
    const life = (frame - callout.startFrame) / 60;
    const remain = (callout.endFrame - frame) / 60;
    const appear = Math.min(damp(life, 16), damp(remain, 18));
    const rawX = xAt(callout.anchor);
    const arrived = playhead >= callout.anchor - 0.25;
    const anchorPrice = arrived ? sample(animation.prices, callout.anchor) : reading.price;
    const rawY = arrived ? yAt(anchorPrice) : tip ? tip.y : yAt(anchorPrice);
    if (appear > 0.02 && pointInside(rawX, rawY)) {
      marks.push({
        kind: 'callout',
        text: callout.kind === 'drawdown' && reading.calloutText ? reading.calloutText : callout.text,
        ax: rawX,
        ay: Math.max(PLOT.y + 8, Math.min(PLOT.y + PLOT.h - 8, rawY)),
        color: INK,
        accent: callout.tone === 'down' ? DOWN : callout.tone === 'up' ? UP : 'rgba(255,255,255,0.55)',
        boxed: true,
        alpha: appear,
      });
    }
  }
  return marks;
}

function pushExtreme(marks: Mark[], animation: Animation, kind: 'peak' | 'low', index: number, playhead: number): void {
  if (playhead < index + 0.5) return;
  if (index < viewLeft - 0.5 || index > viewRight + 0.5) return;
  const price = animation.prices[index];
  const date = animation.dates[index];
  if (price === undefined || !date) return;
  const x = xAt(index);
  const y = yAt(price);
  if (!pointInside(x, y)) return;
  marks.push({
    kind,
    text: `${kind === 'peak' ? 'PEAK' : 'LOW'} ${formatPrice(animation.currency, price)} · ${formatMonthStamp(date)}`,
    ax: x,
    ay: y,
    color: kind === 'peak' ? UP : DOWN,
    accent: null,
    boxed: false,
    alpha: 1,
  });
}

function placeNear(ctx: Ctx, mark: Mark, placed: readonly PlacedMark[]): PlacedMark | null {
  const box = chooseSlot(ctx, mark, placed);
  return box ? { ...mark, box } : null;
}

function placeStart(ctx: Ctx, mark: Mark, placed: readonly PlacedMark[]): PlacedMark | null {
  const size = measureMark(ctx, mark);
  const now = placed.find((item) => item.kind === 'now');
  const sides: SlotSide[] = !now || now.ay >= mark.ay ? ['above', 'below'] : ['below', 'above'];
  const right = PLOT.x + PLOT.w - Math.round(PLOT.w * RIGHT_PAD) - 12;
  const left = PLOT.x + 36;
  for (let ax = right; ax >= left; ax -= 48) {
    const placedMark = slotAt(mark, size, ax, sides, [22, 48, 76], 84, placed);
    if (placedMark) return placedMark;
  }
  return null;
}

function chooseSlot(ctx: Ctx, mark: Mark, placed: readonly PlacedMark[]): Box | null {
  const size = measureMark(ctx, mark);
  const gaps = mark.kind === 'callout' ? [28, 52, 80] : [18, 36, 56];
  const maxLead = mark.kind === 'callout' ? 112 : 64;
  const found = slotAt(mark, size, mark.ax, sideOrder(mark.kind, mark.ax), gaps, maxLead, placed);
  return found?.box ?? null;
}

function slotAt(
  mark: Mark,
  size: { w: number; h: number },
  ax: number,
  sides: readonly SlotSide[],
  gaps: readonly number[],
  maxLead: number,
  placed: readonly PlacedMark[],
): PlacedMark | null {
  for (const gap of gaps) {
    for (const side of sides) {
      const origin = slotOrigin(side, ax, mark.ay, size.w, size.h, gap);
      const box = containBox({ x: origin.x, y: origin.y, w: size.w, h: size.h });
      if (!box || coversPoint(box, ax, mark.ay, 8)) continue;
      if (placed.some((item) => lanesCollide(box, item.box))) continue;
      const edge = nearestEdge(box.x, box.y, box.w, box.h, ax, mark.ay);
      const lead = Math.hypot(edge.x - ax, edge.y - mark.ay);
      if (lead > maxLead) continue;
      if (placed.some((item) => segmentHitsBox(edge.x, edge.y, ax, mark.ay, item.box, 4))) continue;
      return { ...mark, ax, box };
    }
  }
  return null;
}

function measureMark(ctx: Ctx, mark: Mark): { w: number; h: number } {
  ctx.font = mark.boxed ? CALLOUT_FONT : LABEL_FONT;
  const textW = ctx.measureText(mark.text).width;
  if (mark.boxed) return { w: Math.min(PLOT.w - 32, textW + 36), h: 40 };
  return { w: textW + 10, h: 26 };
}

function sideOrder(kind: MarkKind, ax: number): SlotSide[] {
  const towardOpen: SlotSide[] = ax > PLOT.x + PLOT.w * 0.58
    ? ['left', 'aboveLeft', 'belowLeft', 'above', 'below', 'aboveRight', 'belowRight', 'right']
    : ['right', 'aboveRight', 'belowRight', 'above', 'below', 'aboveLeft', 'belowLeft', 'left'];
  if (kind === 'peak') return ['above', 'aboveLeft', 'aboveRight', 'left', 'right', 'below', 'belowLeft', 'belowRight'];
  if (kind === 'low') return ['below', 'belowLeft', 'belowRight', 'left', 'right', 'above', 'aboveLeft', 'aboveRight'];
  if (kind === 'callout') return ['above', 'below', 'aboveLeft', 'belowLeft', 'aboveRight', 'belowRight', 'left', 'right'];
  return towardOpen;
}

function slotOrigin(side: SlotSide, ax: number, ay: number, w: number, h: number, gap: number): { x: number; y: number } {
  switch (side) {
    case 'above':
      return { x: ax - w / 2, y: ay - h - gap };
    case 'below':
      return { x: ax - w / 2, y: ay + gap };
    case 'left':
      return { x: ax - w - gap, y: ay - h / 2 };
    case 'right':
      return { x: ax + gap, y: ay - h / 2 };
    case 'aboveLeft':
      return { x: ax - w - gap * 0.65, y: ay - h - gap };
    case 'aboveRight':
      return { x: ax + gap * 0.35, y: ay - h - gap };
    case 'belowLeft':
      return { x: ax - w - gap * 0.65, y: ay + gap };
    case 'belowRight':
      return { x: ax + gap * 0.35, y: ay + gap };
    default: {
      const exhaustive: never = side;
      return exhaustive;
    }
  }
}

function drawLeader(ctx: Ctx, mark: PlacedMark): void {
  const edge = nearestEdge(mark.box.x, mark.box.y, mark.box.w, mark.box.h, mark.ax, mark.ay);
  const dx = mark.ax - edge.x;
  const dy = mark.ay - edge.y;
  const length = Math.hypot(dx, dy);
  if (length < 2) return;
  const trim = Math.min(3, length * 0.12);
  ctx.globalAlpha = mark.alpha;
  ctx.strokeStyle = 'rgba(247,248,251,0.78)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(edge.x, edge.y);
  ctx.lineTo(mark.ax - (dx / length) * trim, mark.ay - (dy / length) * trim);
  ctx.stroke();
}

function drawMark(ctx: Ctx, mark: PlacedMark): void {
  ctx.globalAlpha = mark.alpha;
  if (mark.boxed) {
    roundRect(ctx, mark.box.x, mark.box.y, mark.box.w, mark.box.h, 10);
    ctx.fillStyle = 'rgba(7,8,11,0.94)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = mark.accent ?? INK;
    ctx.fillRect(mark.box.x, mark.box.y, 3, mark.box.h);
    ctx.font = CALLOUT_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK;
    ctx.fillText(mark.text, mark.box.x + 16, mark.box.y + mark.box.h / 2);
    return;
  }
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(7,8,11,0.94)';
  ctx.strokeText(mark.text, mark.box.x + 5, mark.box.y + mark.box.h / 2);
  ctx.fillStyle = mark.color;
  ctx.fillText(mark.text, mark.box.x + 5, mark.box.y + mark.box.h / 2);
}

function pointInside(x: number, y: number): boolean {
  return x >= PLOT.x + 8 && x <= PLOT.x + PLOT.w - 8 && y >= PLOT.y + 8 && y <= PLOT.y + PLOT.h - 8;
}

function lanesCollide(a: Box, b: Box): boolean {
  const sharesColumn = a.x < b.x + b.w + 28 && b.x < a.x + a.w + 28;
  const pad = sharesColumn ? 56 : 12;
  return a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

function segmentHitsBox(x1: number, y1: number, x2: number, y2: number, box: Box, pad: number): boolean {
  const left = box.x - pad;
  const right = box.x + box.w + pad;
  const top = box.y - pad;
  const bottom = box.y + box.h + pad;
  for (let step = 2; step < 12; step += 1) {
    const t = step / 12;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    if (x >= left && x <= right && y >= top && y <= bottom) return true;
  }
  return false;
}

function drawGrid(ctx: Ctx): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.globalAlpha = 1;
  for (const tick of linearTicks()) strokeGrid(ctx, tick.y);
  ctx.restore();
}

function strokeGrid(ctx: Ctx, y: number): void {
  ctx.beginPath();
  ctx.moveTo(PLOT.x, y);
  ctx.lineTo(PLOT.x + PLOT.w, y);
  ctx.stroke();
}

function drawYLabels(ctx: Ctx, currency: string): void {
  ctx.font = '500 26px "Geist Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  for (const tick of linearTicks()) ctx.fillText(formatAxis(currency, tick.value), PLOT.x - 16, tick.y);
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

function placeTicks(values: number[]): { value: number; y: number }[] {
  const placed: { value: number; y: number }[] = [];
  for (const value of values) {
    const y = yAt(value);
    if (y < PLOT.y + 20 || y > PLOT.y + PLOT.h - 20) continue;
    if (placed.some((tick) => Math.abs(tick.y - y) < 52)) continue;
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

function drawArea(ctx: Ctx, run: Run, startY: number, alpha: number): void {
  if (run.points.length < 2) return;
  const first = run.points[0];
  const last = run.points[run.points.length - 1];
  if (!first || !last) return;
  ctx.beginPath();
  traceCurve(ctx, run.points);
  ctx.lineTo(last.x, startY);
  ctx.lineTo(first.x, startY);
  ctx.closePath();
  ctx.globalAlpha = alpha * (run.above ? 0.3 : 0.07);
  ctx.fillStyle = run.above ? UP : DOWN;
  ctx.fill();
}

function drawRun(ctx: Ctx, run: Run, alpha: number): void {
  if (run.points.length < 2) return;
  const layers = [
    { width: 26, alpha: alpha * 0.22 },
    { width: 14, alpha: alpha * 0.45 },
    { width: 7, alpha },
  ];
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = run.above ? UP : DOWN;
  for (const layer of layers) {
    ctx.beginPath();
    traceCurve(ctx, run.points);
    ctx.lineWidth = layer.width;
    ctx.globalAlpha = layer.alpha;
    ctx.stroke();
  }
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
  ctx.font = '500 22px "Geist Mono", monospace';
  ctx.fillStyle = INK;
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

function collectPoints(animation: Animation, playhead: number, open: number, price: number): Point[] {
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
    if (item.anchor >= start && item.anchor <= end && item.anchor <= playhead) indexes.push(item.anchor);
  }
  indexes.sort((a, b) => a - b);
  const points: Point[] = [];
  let previous = -Infinity;
  for (const index of indexes) {
    if (Math.abs(index - playhead) < 1e-4 || index - previous < 1e-4) continue;
    previous = index;
    const drawn = sample(animation.prices, index);
    points.push({ x: xAt(index), y: yAt(drawn), price: drawn || open });
  }
  points.push({ x: xAt(playhead), y: yAt(price), price: price || open });
  return points;
}

function splitRuns(points: readonly Point[], open: number): Run[] {
  const first = points[0];
  if (!first) return [];
  const band = Math.max(1e-4, Math.abs(open) * 0.008);
  const runs: Run[] = [];
  let batch: Point[] = [first];
  let above = first.price >= open;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const point = points[i];
    if (!prev || !point) continue;
    const nextAbove = above ? point.price >= open - band : point.price > open + band;
    if (nextAbove !== above && point.price !== prev.price) {
      const threshold = above ? open - band : open + band;
      const span = point.price - prev.price;
      const t = span === 0 ? 1 : Math.max(0, Math.min(1, (threshold - prev.price) / span));
      const mid: Point = {
        x: prev.x + (point.x - prev.x) * t,
        y: prev.y + (point.y - prev.y) * t,
        price: threshold,
      };
      batch.push(mid);
      runs.push({ above, points: batch });
      batch = [mid, point];
      above = nextAbove;
    } else {
      batch.push(point);
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
    if (target.right > playhead && target.right > right) {
      right = target.right;
      velocityRight = 0;
    }
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
  const end = Math.min(prices.length - 1, Math.max(start, Math.floor(playhead)));
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

function revealedPath(prices: readonly number[], dates: readonly string[], playhead: number): { prices: number[]; dates: string[] } {
  const last = Math.max(0, Math.min(prices.length - 1, Math.floor(playhead)));
  const pathPrices = prices.slice(0, last + 1);
  const pathDates = dates.slice(0, last + 1);
  const head = sample(prices, Math.min(prices.length - 1, Math.max(0, playhead)));
  const floorPrice = pathPrices[pathPrices.length - 1] ?? head;
  if (Math.abs(head - floorPrice) > 1e-8) {
    pathPrices.push(head);
    pathDates.push(pathDates[pathDates.length - 1] ?? '');
  }
  return { prices: pathPrices, dates: pathDates };
}

function xAt(index: number): number {
  const span = Math.max(1e-6, viewRight - viewLeft);
  const leftInset = 28;
  const rightInset = Math.round(PLOT.w * RIGHT_PAD);
  return PLOT.x + leftInset + ((index - viewLeft) / span) * (PLOT.w - leftInset - rightInset);
}

function yAt(price: number): number {
  const unit = (price - viewLo) / Math.max(1e-6, viewHi - viewLo);
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
  const left = x;
  const right = x + w;
  const top = y;
  const bottom = y + h;
  const cx = Math.max(left, Math.min(ax, right));
  const cy = Math.max(top, Math.min(ay, bottom));
  const outside = ax < left || ax > right || ay < top || ay > bottom;
  if (outside) return { x: cx, y: cy };
  const toLeft = ax - left;
  const toRight = right - ax;
  const toTop = ay - top;
  const toBottom = bottom - ay;
  const nearest = Math.min(toLeft, toRight, toTop, toBottom);
  if (nearest === toTop) return { x: ax, y: top };
  if (nearest === toBottom) return { x: ax, y: bottom };
  if (nearest === toLeft) return { x: left, y: ay };
  return { x: right, y: ay };
}

function containBox(box: Box): Box | null {
  const minX = PLOT.x + 8;
  const minY = PLOT.y + 8;
  const maxX = PLOT.x + PLOT.w - 28;
  const maxY = PLOT.y + PLOT.h - 8;
  if (box.w > maxX - minX || box.h > maxY - minY) return null;
  let x = box.x;
  let y = box.y;
  if (x < minX) x = minX;
  if (y < minY) y = minY;
  if (x + box.w > maxX) x = maxX - box.w;
  if (y + box.h > maxY) y = maxY - box.h;
  return { x, y, w: box.w, h: box.h };
}

function coversPoint(box: Box, ax: number, ay: number, pad: number): boolean {
  return ax >= box.x - pad && ax <= box.x + box.w + pad && ay >= box.y - pad && ay <= box.y + box.h + pad;
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

function windowTag(start: string, end: string): string {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  const days = Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.round((to - from) / 86_400_000)) : 0;
  if (days < 45) return `${Math.max(1, days)}D`;
  if (days < 330) return `${Math.max(1, Math.round(days / 30.4375))}M`;
  return `${Math.max(1, Math.round(days / 365.25))}Y`;
}

function fitSubtitle(ctx: Ctx, text: string, maxWidth: number): string {
  let size = 24;
  while (size > 16) {
    ctx.font = `500 ${size}px Geist, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return text;
    size -= 1;
  }
  ctx.font = '500 16px Geist, sans-serif';
  return text;
}

function fitValue(ctx: Ctx, text: string, maxWidth: number): string {
  let size = 40;
  while (size > 26) {
    ctx.font = `600 ${size}px Geist, sans-serif`;
    if (measureTabular(ctx, text) <= maxWidth) return text;
    size -= 1;
  }
  ctx.font = '600 26px Geist, sans-serif';
  return text;
}

function wrapFoot(ctx: Ctx, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth) line = next;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function fitMonoSize(ctx: Ctx, text: string, maxWidth: number, start: number, floor: number): number {
  let size = start;
  while (size > floor) {
    ctx.font = `500 ${size}px "Geist Mono", monospace`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 1;
  }
  ctx.font = `500 ${floor}px "Geist Mono", monospace`;
  return floor;
}

function measureTabular(ctx: Ctx, text: string): number {
  const digit = ctx.measureText('0').width;
  let width = 0;
  for (const char of text) width += char >= '0' && char <= '9' ? digit : ctx.measureText(char).width;
  return width;
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
