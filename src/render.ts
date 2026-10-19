import {
  activeCallout,
  damp,
  detectEvents,
  easeInOut,
  ESTABLISH_END,
  formatInSpan,
  formatLongDate,
  formatMonthStamp,
  formatMonthYear,
  formatPercent,
  formatPrice,
  formatShortMonth,
  formatSignedPrice,
  FPS,
  growthSoFar,
  FRAME_COUNT,
  HOOK_END,
  maxDrawdownSoFar,
  placeCallouts,
  PLAY_END,
  playheadSeries,
  rangeSoFar,
  roundMoney,
  slowIndexes,
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

const WIDTH = 1920;
const HEIGHT = 1080;
const PANEL = { x: 48, y: 400, w: 1824, h: 628 };
const PLOT = { x: 220, y: 426, w: 1608, h: 528 };
/** Share of the plot kept clear on the right so the endpoint, NOW, and callouts are not clipped. */
export const RIGHT_PAD_RATIO = 0.09;
export const PLOT_FRAME = PLOT;
const LEFT_PAD = 32;
const CARD_X = 508;
const CARD_W = 444;
const CARD_H = 208;
const CARD_GAP = 16;
const CARD_Y = 28;
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
  const view = buildView(prices, reveal);
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
    hookFrame: 108,
    calloutFrame: featured ? Math.min(FRAME_COUNT - 1, featured.startFrame + 18) : Math.floor(FRAME_COUNT / 2),
  };
}

export function priceAt(animation: Animation, frame: number): number {
  const index = animation.reveal[clampFrame(frame)] ?? 0;
  return sample(animation.prices, index);
}

export interface FrameReadout {
  playhead: number;
  /** Canonical share price for this frame, in cents. Hero, NOW, and the CAGR “to” price all use it. */
  price: number;
  open: number;
  delta: number;
  /** Period change from the rounded open to `price`. */
  change: number;
  date: string;
  high: number;
  highDate: string;
  low: number;
  lowDate: string;
  drop: number;
  dropPeak: number;
  dropTrough: number;
  dropPeakDate: string;
  dropTroughDate: string;
  /** True annualized rate. Never the raw period change. */
  cagr: number;
  years: number;
  /** Always ends with `/yr`. */
  cagrText: string;
  calloutKind: VisibleCallout['kind'] | null;
  /** Fraction drawn when the callout shows a percent. Drawdowns use `drop`. */
  calloutFraction: number | null;
  calloutText: string | null;
}

/**
 * Every number on this frame, taken from the closes revealed so far.
 * The current price is the playhead sample rounded to the cent. High, low,
 * drawdown, and CAGR are computed from those same rounded closes.
 */
export function frameReadout(animation: Animation, frame: number): FrameReadout {
  const index = clampFrame(frame);
  const playhead = animation.reveal[index] ?? 0;
  const revealed = revealedCloses(animation.prices, animation.dates, playhead);
  const open = revealed.prices[0] ?? 0;
  const price = revealed.price;
  const last = Math.max(0, revealed.prices.length - 1);
  const range = rangeSoFar(revealed.prices, revealed.dates, last);
  const drawdown = maxDrawdownSoFar(revealed.prices, revealed.dates, last);
  const growth = growthSoFar(open, price, animation.dates[0] ?? '', revealed.date);
  const callout = activeCallout(animation.schedule, index);
  let calloutKind: FrameReadout['calloutKind'] = null;
  let calloutFraction: number | null = null;
  let calloutText: string | null = null;
  if (callout) {
    calloutKind = callout.kind;
    if (callout.kind === 'drawdown') {
      calloutFraction = drawdown.depth;
      calloutText = `${formatPercent(drawdown.depth)} ${formatInSpan(drawdown.peakDate, drawdown.troughDate)}`;
    } else if (callout.kind === 'up' || callout.kind === 'down') {
      const at = Math.min(Math.max(0, callout.anchor), last);
      const prev = revealed.prices[Math.max(0, at - 1)] ?? open;
      const cur = revealed.prices[at] ?? price;
      calloutFraction = prev === 0 ? 0 : cur / prev - 1;
      calloutText = `${formatPercent(calloutFraction)} · ${formatLongDate(revealed.dates[at] ?? revealed.date)}`;
    } else {
      calloutText = callout.text;
    }
  }
  return {
    playhead,
    price,
    open,
    delta: roundMoney(price - open),
    change: open === 0 ? 0 : price / open - 1,
    date: revealed.date,
    high: range.high,
    highDate: range.highDate,
    low: range.low,
    lowDate: range.lowDate,
    drop: drawdown.depth,
    dropPeak: drawdown.peak,
    dropTrough: drawdown.trough,
    dropPeakDate: drawdown.peakDate,
    dropTroughDate: drawdown.troughDate,
    cagr: growth.rate,
    years: growth.years,
    cagrText: `${formatPercent(growth.rate)}/yr`,
    calloutKind,
    calloutFraction,
    calloutText,
  };
}

export type FramePhase = 'hook' | 'travel' | 'verdict';

/** Hook asks from the first close. Travel moves. The verdict is the last beat only. */
export function framePhase(frame: number): FramePhase {
  const index = clampFrame(frame);
  if (index < ESTABLISH_END) return 'hook';
  if (index >= PLAY_END) return 'verdict';
  return 'travel';
}

/** One sentence for the end card. Every figure is the frame readout. */
export function verdictText(currency: string, readout: FrameReadout): string {
  return `${formatPrice(currency, readout.open)} → ${formatPrice(currency, readout.price)} · ${formatPercent(readout.cagr)}/yr · ${formatPercent(readout.drop)} max drop`;
}

export function drawFrame(ctx: Ctx, animation: Animation, frame: number): void {
  const index = clampFrame(frame);
  const readout = frameReadout(animation, index);
  const playhead = readout.playhead;
  const open = readout.open;
  const phase = framePhase(index);
  viewLeft = animation.windowLeft[index] ?? 0;
  viewRight = Math.max(viewLeft + 1e-3, animation.windowRight[index] ?? viewLeft + 1);
  viewLo = animation.yMin[index] ?? readout.price;
  viewHi = animation.yMax[index] ?? Math.max(readout.price, viewLo + 1);
  if (!(viewHi > viewLo)) viewHi = viewLo + 1;
  const canvas = ctx.canvas;
  ctx.setTransform(canvas.width / WIDTH, 0, 0, canvas.height / HEIGHT, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  fillStage(ctx);

  roundRect(ctx, PANEL.x, PANEL.y, PANEL.w, PANEL.h, 16);
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  drawHeader(ctx, animation, readout, index, phase);
  if (phase !== 'hook') drawCards(ctx, animation, readout, index);

  ctx.save();
  ctx.beginPath();
  ctx.rect(PLOT.x, PLOT.y, PLOT.w, PLOT.h);
  ctx.clip();
  const axisIn = index < HOOK_END ? 0.45 + 0.55 * easeInOut(index / Math.max(1, HOOK_END - 1)) : 1;
  ctx.globalAlpha = axisIn;
  drawGrid(ctx);
  if (phase !== 'hook') drawYearDividers(ctx, animation);
  ctx.globalAlpha = 1;
  const points = collectPoints(animation, playhead, open);
  if (phase === 'hook') drawOriginScar(ctx, open, index);
  else {
    drawSeries(ctx, animation, playhead, open, 1);
    drawStartLine(ctx, open);
    drawExtremeDot(ctx, animation, indexOnDate(animation, readout.highDate), playhead);
    drawExtremeDot(ctx, animation, indexOnDate(animation, readout.lowDate), playhead);
    const tip = points[points.length - 1];
    if (tip) drawHeadDot(ctx, tip, readout.price >= open);
  }
  ctx.restore();

  ctx.globalAlpha = axisIn;
  drawYLabels(ctx, animation.currency);
  drawXLabels(ctx, animation);
  ctx.globalAlpha = 1;
  if (phase !== 'hook') drawAnnotations(ctx, animation, readout, index, points);
  drawSource(ctx);
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function drawPoster(ctx: Ctx): void {
  const canvas = ctx.canvas;
  ctx.setTransform(canvas.width / WIDTH, 0, 0, canvas.height / HEIGHT, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  fillStage(ctx);

  const frame = { x: 48, y: 56, w: 1824, h: 968 };
  roundRect(ctx, frame.x, frame.y, frame.w, frame.h, 16);
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.font = '600 40px Geist, sans-serif';
  ctx.fillText('One share price', 96, 148);
  ctx.font = '500 20px Geist, sans-serif';
  ctx.fillStyle = '#d5dbe6';
  ctx.fillText('From the first close to the last.', 96, 188);

  const examples = ['NVDA', 'AAPL', '0700.HK'];
  ctx.font = '500 18px "Geist Mono", monospace';
  let cursor = 96;
  const chipY = 236;
  for (const example of examples) {
    const width = ctx.measureText(example).width;
    roundRect(ctx, cursor - 14, chipY - 22, width + 28, 34, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.fillText(example, cursor, chipY);
    cursor += width + 52;
  }

  const plot = { x: 168, y: 360, w: 1624, h: 560 };
  const axisY = plot.y + 470;
  const years = ["Oct '21", "Oct '22", "Oct '23", "Oct '24", "Oct '25", "Oct '26"];

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.font = '600 32px Geist, sans-serif';
  ctx.fillText('Opens on the first close.', plot.x, plot.y + 56);
  ctx.font = '500 20px Geist, sans-serif';
  ctx.fillStyle = '#d5dbe6';
  ctx.fillText('The price travels. The last frame states the path.', plot.x, plot.y + 96);

  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  years.forEach((year, index) => {
    const x = plot.x + (plot.w * index) / (years.length - 1);
    ctx.beginPath();
    ctx.moveTo(x, plot.y + 176);
    ctx.lineTo(x, axisY);
    ctx.stroke();
  });

  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.beginPath();
  ctx.moveTo(plot.x, axisY);
  ctx.lineTo(plot.x + plot.w, axisY);
  ctx.stroke();

  ctx.beginPath();
  ctx.fillStyle = INK;
  ctx.arc(plot.x + 8, axisY, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.setLineDash([2, 7]);
  ctx.strokeStyle = 'rgba(247,248,251,0.75)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(plot.x + 8, axisY);
  ctx.lineTo(plot.x + 132, axisY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = '500 18px "Geist Mono", monospace';
  ctx.fillStyle = '#d5dbe6';
  ctx.textBaseline = 'top';
  years.forEach((year, index) => {
    const x = plot.x + (plot.w * index) / (years.length - 1);
    ctx.textAlign = index === 0 ? 'left' : index === years.length - 1 ? 'right' : 'center';
    ctx.fillText(year, x, axisY + 22);
  });

  ctx.font = '500 16px Geist, sans-serif';
  ctx.fillStyle = '#d5dbe6';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Data: Yahoo Finance', WIDTH - 72, frame.y + frame.h - 28);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function drawLoading(ctx: Ctx, ticker: string): void {
  const canvas = ctx.canvas;
  ctx.setTransform(canvas.width / WIDTH, 0, 0, canvas.height / HEIGHT, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  fillStage(ctx);
  roundRect(ctx, PANEL.x, PANEL.y, PANEL.w, PANEL.h, 16);
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.rect(PLOT.x, PLOT.y, PLOT.w, PLOT.h);
  ctx.clip();
  ctx.globalAlpha = 0.55;
  drawPosterGrid(ctx);
  ctx.restore();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  const size = fitLineSize(ctx, ticker, 600, 48, 32, '600');
  ctx.font = `600 ${size}px Geist, sans-serif`;
  ctx.fillText(ticker, 96, 148);
  ctx.font = '500 16px Geist, sans-serif';
  ctx.fillStyle = '#d5dbe6';
  ctx.textAlign = 'right';
  ctx.fillText('Data: Yahoo Finance', WIDTH - 48, 1064);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function fillStage(ctx: Ctx): void {
  const background = ctx.createRadialGradient(980, 420, 80, 960, 560, 1180);
  background.addColorStop(0, '#141820');
  background.addColorStop(0.62, '#0c0e13');
  background.addColorStop(1, '#07080b');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawPosterGrid(ctx: Ctx): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  for (let i = 1; i <= 4; i += 1) {
    const y = PLOT.y + (PLOT.h * i) / 5;
    ctx.beginPath();
    ctx.moveTo(PLOT.x, y);
    ctx.lineTo(PLOT.x + PLOT.w, y);
    ctx.stroke();
  }
  ctx.setLineDash([3, 8]);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  for (let i = 1; i <= 4; i += 1) {
    const x = PLOT.x + (PLOT.w * i) / 5;
    ctx.beginPath();
    ctx.moveTo(x, PLOT.y);
    ctx.lineTo(x, PLOT.y + PLOT.h);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHeader(ctx: Ctx, animation: Animation, readout: FrameReadout, frame: number, phase: FramePhase): void {
  const ticker = shortSymbol(animation.symbol);
  const titleMax = CARD_X - 72;
  drawTitle(ctx, ticker, animation.name, titleMax);

  ctx.font = '500 16px Geist, sans-serif';
  ctx.fillStyle = '#c5cedd';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`Share price  ·  ${animation.currency}`, 48, 90);

  const shown = phase === 'hook' ? readout.open : readout.price;
  const hero = formatPrice(animation.currency, shown);
  const heroMax = CARD_X - 80;
  const heroSize = fitLineSize(ctx, hero, heroMax, 52, 36, '600');
  ctx.font = `600 ${heroSize}px Geist, sans-serif`;
  ctx.fillStyle = INK;
  drawTabular(ctx, hero, 48, 152);

  if (phase !== 'hook') {
    const pillIn = damp(Math.max(0, frame - ESTABLISH_END) / 50);
    ctx.save();
    ctx.globalAlpha = pillIn;
    drawDeltaPill(
      ctx,
      `${formatSignedPrice(animation.currency, readout.delta)}  ·  ${formatPercent(readout.change)}`,
      48,
      198,
      readout.delta >= 0,
    );
    ctx.restore();
  }

  if (phase === 'verdict') {
    const appear = damp((frame - PLAY_END) / 45, 10);
    drawVerdict(ctx, animation.currency, readout, appear);
    return;
  }

  ctx.font = '500 18px Geist, sans-serif';
  ctx.fillStyle = '#d5dbe6';
  ctx.textAlign = 'left';
  const line =
    phase === 'hook'
      ? `Started ${formatLongDate(animation.dates[0] ?? readout.date)}`
      : `${formatMonthYear(readout.date)}  ·  since ${formatMonthYear(animation.dates[0] ?? readout.date)}`;
  ctx.fillText(line, 48, phase === 'hook' ? 198 : 246);
}

function drawVerdict(ctx: Ctx, currency: string, readout: FrameReadout, appear: number): void {
  if (appear <= 0.01) return;
  const parts = [
    { text: `${formatPrice(currency, readout.open)} → ${formatPrice(currency, readout.price)}`, color: INK },
    { text: '   ·   ', color: '#9aa6ba' },
    { text: `${formatPercent(readout.cagr)}/yr`, color: readout.cagr >= 0 ? UP : DOWN },
    { text: '   ·   ', color: '#9aa6ba' },
    { text: `${formatPercent(readout.drop)} max drop`, color: readout.drop < -0.005 ? DOWN : '#d5dbe6' },
  ];
  const maxWidth = WIDTH - 96;
  let size = 30;
  const widthAt = (px: number) => {
    ctx.font = `600 ${px}px Geist, sans-serif`;
    return parts.reduce((sum, part) => sum + ctx.measureText(part.text).width, 0);
  };
  while (size > 20 && widthAt(size) > maxWidth) size -= 1;
  ctx.save();
  ctx.globalAlpha = appear;
  ctx.font = `600 ${size}px Geist, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let x = 48;
  const y = 276;
  for (const part of parts) {
    ctx.fillStyle = part.color;
    ctx.fillText(part.text, x, y);
    x += ctx.measureText(part.text).width;
  }
  ctx.restore();
}

function drawTitle(ctx: Ctx, ticker: string, name: string, maxWidth: number): void {
  let size = 38;
  while (size > 24 && titleWidth(ctx, ticker, name, size) > maxWidth) size -= 1;
  const nameSize = Math.max(16, Math.round(size * 0.68));
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 ${size}px Geist, sans-serif`;
  ctx.fillStyle = INK;
  ctx.fillText(ticker, 48, 58);
  const tickerWidth = ctx.measureText(ticker).width;
  ctx.font = `500 ${nameSize}px Geist, sans-serif`;
  ctx.fillStyle = '#d5dbe6';
  const label = `  ${name}`;
  const room = Math.max(0, maxWidth - tickerWidth);
  ctx.fillText(ctx.measureText(label).width <= room ? label : trimText(ctx, label, room), 48 + tickerWidth, 58);
}

interface RangeCard {
  kind: 'range';
  title: string;
  high: string;
  highMeta: string;
  low: string;
  lowMeta: string;
}

interface StatCard {
  kind: 'stat';
  title: string;
  value: string;
  color: string;
  accent: string;
  foot: string;
}

function drawCards(ctx: Ctx, animation: Animation, readout: FrameReadout, frame: number): void {
  const range: RangeCard = {
    kind: 'range',
    title: `RANGE · ${windowTag(animation.dates[0] ?? '', readout.date)}`,
    high: formatPrice(animation.currency, readout.high),
    highMeta: formatMonthStamp(readout.highDate),
    low: formatPrice(animation.currency, readout.low),
    lowMeta: formatMonthStamp(readout.lowDate),
  };
  const drop: StatCard = {
    kind: 'stat',
    title: 'MAX DROP',
    value: formatPercent(readout.drop),
    color: readout.drop < -0.005 ? DOWN : '#d5dbe6',
    accent: drawdownAccent(readout.drop),
    foot: `${formatPrice(animation.currency, readout.dropPeak)} → ${formatPrice(animation.currency, readout.dropTrough)}`,
  };
  const growth: StatCard = {
    kind: 'stat',
    title: 'CAGR',
    value: readout.cagrText,
    color: readout.cagr >= 0 ? UP : DOWN,
    accent: readout.cagr >= 0 ? UP : DOWN,
    foot: `${formatPrice(animation.currency, readout.open)} → ${formatPrice(animation.currency, readout.price)}`,
  };
  const cards = [range, drop, growth];
  cards.forEach((card, slot) => {
    const appear = damp(Math.max(0, frame - ESTABLISH_END - slot * 8) / 60);
    const x = CARD_X + slot * (CARD_W + CARD_GAP);
    if (card.kind === 'range') drawRangeCard(ctx, x, CARD_Y, CARD_W, CARD_H, appear, card);
    else drawCard(ctx, x, CARD_Y, CARD_W, CARD_H, appear, card);
  });
}

function drawCard(ctx: Ctx, x: number, y: number, w: number, h: number, appear: number, card: StatCard): void {
  if (appear <= 0.01) return;
  const slide = (1 - appear) * 16;
  ctx.save();
  ctx.globalAlpha = appear;
  paintCardShell(ctx, x, y + slide, w, h, card.accent);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '500 16px "Geist Mono", monospace';
  ctx.fillStyle = '#c5cedd';
  fillTracked(ctx, card.title, x + 20, y + slide + 36, 1.2);
  const valueSize = fitLineSize(ctx, card.value, w - 40, 34, 24, '600');
  ctx.font = `600 ${valueSize}px Geist, sans-serif`;
  ctx.fillStyle = card.color;
  drawTabular(ctx, card.value, x + 20, y + slide + 96);
  const footSize = fitMonoSize(ctx, card.foot, w - 40, 20, 16);
  ctx.font = `500 ${footSize}px "Geist Mono", monospace`;
  ctx.fillStyle = '#e8edf4';
  ctx.fillText(card.foot, x + 20, y + slide + 148);
  ctx.restore();
}

function drawRangeCard(ctx: Ctx, x: number, y: number, w: number, h: number, appear: number, card: RangeCard): void {
  if (appear <= 0.01) return;
  const slide = (1 - appear) * 16;
  ctx.save();
  ctx.globalAlpha = appear;
  paintCardShell(ctx, x, y + slide, w, h, 'rgba(255,255,255,0.7)');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '500 16px "Geist Mono", monospace';
  ctx.fillStyle = '#c5cedd';
  fillTracked(ctx, card.title, x + 20, y + slide + 36, 1.2);
  drawRangeRow(ctx, x + 20, y + slide + 92, w - 40, 'HIGH', card.high, card.highMeta, UP);
  drawRangeRow(ctx, x + 20, y + slide + 152, w - 40, 'LOW', card.low, card.lowMeta, DOWN);
  ctx.restore();
}

function drawRangeRow(
  ctx: Ctx,
  x: number,
  baseline: number,
  width: number,
  label: string,
  price: string,
  meta: string,
  color: string,
): void {
  ctx.font = '600 15px "Geist Mono", monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(label, x, baseline);
  ctx.font = '500 16px "Geist Mono", monospace';
  ctx.fillStyle = '#e8edf4';
  ctx.textAlign = 'right';
  const metaWidth = ctx.measureText(meta).width;
  ctx.fillText(meta, x + width, baseline);
  const priceSize = fitLineSize(ctx, price, Math.max(80, width - 64 - metaWidth - 16), 28, 20, '600');
  ctx.font = `600 ${priceSize}px Geist, sans-serif`;
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  drawTabular(ctx, price, x + 64, baseline);
}

function paintCardShell(ctx: Ctx, x: number, y: number, w: number, h: number, accent: string): void {
  roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, w, 3);
}

function drawDeltaPill(ctx: Ctx, text: string, x: number, baseline: number, up: boolean): void {
  ctx.font = '600 18px Geist, sans-serif';
  const width = measureTabular(ctx, text) + 24;
  const height = 30;
  const top = baseline - 22;
  ctx.save();
  roundRect(ctx, x, top, width, height, 15);
  ctx.fillStyle = up ? 'rgba(61,220,151,0.18)' : 'rgba(255,93,108,0.2)';
  ctx.fill();
  ctx.strokeStyle = up ? 'rgba(61,220,151,0.7)' : 'rgba(255,93,108,0.75)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = up ? '#b6ffd8' : '#ffc7ce';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  drawTabular(ctx, text, x + 12, baseline);
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

function drawSeries(ctx: Ctx, animation: Animation, playhead: number, open: number, alpha: number): void {
  const points = collectPoints(animation, playhead, open);
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

const LABEL_FONT = '600 22px "Geist Mono", monospace';
const CALLOUT_FONT = '600 24px "Geist Mono", monospace';

function drawAnnotations(
  ctx: Ctx,
  animation: Animation,
  readout: FrameReadout,
  frame: number,
  points: readonly Point[],
): void {
  const marks = collectMarks(animation, readout, frame, points);
  const measured: MarkerInput[] = marks.map((mark) => {
    const size = measureMark(ctx, mark);
    return { kind: mark.kind, ax: mark.ax, ay: mark.ay, w: size.w, h: size.h };
  });
  const segments = toSegments(points);
  const openY = yAt(readout.open);
  if (openY >= PLOT.y && openY <= PLOT.y + PLOT.h) {
    segments.push({ x1: PLOT.x, y1: openY, x2: PLOT.x + PLOT.w, y2: openY });
  }
  const boxes = placeMarkerBoxes(measured, segments, { x: PLOT.x, y: PLOT.y, w: PLOT.w, h: PLOT.h });
  const placed: PlacedMark[] = [];
  marks.forEach((mark, index) => {
    const box = boxes[index];
    if (!box) return;
    placed.push({ ...mark, box });
  });
  ctx.save();
  ctx.setLineDash([]);
  for (const mark of placed) drawLeader(ctx, mark);
  for (const mark of placed) drawMark(ctx, mark);
  ctx.restore();
}

function collectMarks(animation: Animation, readout: FrameReadout, frame: number, points: readonly Point[]): Mark[] {
  const marks: Mark[] = [];
  const tip = points[points.length - 1];
  const playhead = readout.playhead;
  const peakIndex = indexOnDate(animation, readout.highDate);
  const lowIndex = indexOnDate(animation, readout.lowDate);
  const peakHere = peakIndex >= 0 && Math.abs(playhead - peakIndex) < 0.75;
  const lowHere = lowIndex >= 0 && Math.abs(playhead - lowIndex) < 0.75;
  const lowAtStart = lowIndex >= 0 && lowIndex <= 0.5;
  if (tip && pointInside(tip.x, tip.y)) {
    const nowDate = formatMonthStamp(readout.date);
    const nowPrice = formatPrice(animation.currency, readout.price);
    const nowName = peakHere ? 'NOW · PEAK' : lowHere ? 'NOW · LOW' : 'NOW';
    marks.push({
      kind: 'now',
      text: `${nowName} ${nowPrice} · ${nowDate}`,
      ax: tip.x,
      ay: tip.y,
      color: INK,
      accent: null,
      boxed: false,
      alpha: 1,
    });
  }
  if (!peakHere) pushExtreme(marks, animation, 'peak', peakIndex, playhead);
  if (!lowHere && !lowAtStart) pushExtreme(marks, animation, 'low', lowIndex, playhead);
  const startX = xAt(0);
  const startY = yAt(readout.open);
  if (pointInside(startX, startY)) {
    const startDate = formatMonthStamp(animation.dates[0] ?? readout.date);
    const startPrice = formatPrice(animation.currency, readout.open);
    marks.push({
      kind: 'start',
      text: lowAtStart ? `START · LOW ${startPrice} · ${startDate}` : `START ${startPrice} · ${startDate}`,
      ax: startX,
      ay: startY,
      color: INK,
      accent: null,
      boxed: false,
      alpha: 1,
    });
  }
  const callout = activeCallout(animation.schedule, frame);
  if (callout && readout.calloutText && tip) {
    const life = (frame - callout.startFrame) / 60;
    const remain = (callout.endFrame - frame) / 60;
    const appear = Math.min(damp(life, 16), damp(remain, 18));
    const arrived = playhead >= callout.anchor - 0.25;
    const ax = arrived ? xAt(callout.anchor) : tip.x;
    const ay = arrived ? yAt(sample(animation.prices, callout.anchor)) : tip.y;
    if (appear > 0.02 && pointInside(ax, ay)) {
      marks.push({
        kind: 'callout',
        text: readout.calloutText,
        ax,
        ay,
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
  if (index < 0 || playhead < index - 0.25) return;
  if (index < viewLeft - 0.5 || index > viewRight + 0.5) return;
  const raw = animation.prices[index];
  const date = animation.dates[index];
  if (raw === undefined || !date) return;
  const price = roundMoney(raw);
  const x = xAt(index);
  const y = yAt(raw);
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

export interface MarkerInput {
  kind: MarkKind;
  ax: number;
  ay: number;
  w: number;
  h: number;
}

export interface MarkerSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const MARK_RANK: Record<MarkKind, number> = { now: 0, peak: 1, low: 2, start: 3, callout: 4 };

/**
 * Places NOW, then PEAK, then LOW, then START, then a callout.
 * One price label per anchor. Boxes stay off the price line and off each other.
 * A callout that cannot use a short leader moves to the nearest clear plot cell.
 * Returns a box per input, or null when that mark is dropped.
 */
export function placeMarkerBoxes(
  marks: readonly MarkerInput[],
  segments: readonly MarkerSegment[],
  bounds: Box,
): (Box | null)[] {
  const order = marks.map((mark, index) => ({ mark, index }));
  order.sort((a, b) => MARK_RANK[a.mark.kind] - MARK_RANK[b.mark.kind] || a.index - b.index);
  const placed: { box: Box; ax: number; ay: number; kind: MarkKind }[] = [];
  const result: (Box | null)[] = marks.map(() => null);
  const startMark = marks.find((mark) => mark.kind === 'start');
  for (const item of order) {
    const sameAnchor =
      item.mark.kind !== 'callout' &&
      placed.some((other) => other.kind !== 'callout' && Math.hypot(other.ax - item.mark.ax, other.ay - item.mark.ay) < 10);
    if (sameAnchor) continue;
    // A low that is not the start must leave the start column free, or the
    // straight leader from START has to cut through the LOW label.
    const avoidX =
      item.mark.kind === 'low' && startMark && item.mark.ax > startMark.ax + 80 ? startMark.ax : null;
    const box = chooseMarkerSlot(item.mark, placed, segments, bounds, avoidX);
    if (!box) continue;
    result[item.index] = box;
    placed.push({ box, ax: item.mark.ax, ay: item.mark.ay, kind: item.mark.kind });
  }
  return result;
}

interface IndexedSegment extends MarkerSegment {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function chooseMarkerSlot(
  mark: MarkerInput,
  placed: readonly { box: Box; ax: number; ay: number }[],
  segments: readonly MarkerSegment[],
  bounds: Box,
  avoidX: number | null,
): Box | null {
  const linePad = mark.kind === 'callout' ? 14 : 8;
  const lead = mark.kind === 'callout' ? 108 : 120;
  const near = searchNearSlots(mark, placed, segments, bounds, linePad, lead, avoidX);
  if (near) return near;
  const clamped = searchClampedSlots(
    mark,
    placed,
    segments,
    bounds,
    linePad,
    mark.kind === 'callout' ? 140 : 200,
    avoidX,
  );
  if (clamped) return clamped;
  if (mark.kind !== 'callout') return rescuePriceBox(mark, placed, segments, bounds);
  const indexed = indexSegments(segments);
  for (const pad of [10, 6, 2]) {
    const found = searchCalloutGrid(mark, placed, indexed, bounds, pad);
    if (found) return tightenCallout(found, mark, placed, indexed, bounds, pad);
  }
  return null;
}

function coversX(box: Box, x: number): boolean {
  return x >= box.x - 6 && x <= box.x + box.w + 6;
}

/** Last resort for a price label. Keeps a real gap off the line and never drops START. */
function rescuePriceBox(
  mark: MarkerInput,
  placed: readonly { box: Box }[],
  segments: readonly MarkerSegment[],
  bounds: Box,
): Box | null {
  const indexed = indexSegments(segments);
  const minX = bounds.x + 8;
  const minY = bounds.y + 8;
  const maxX = bounds.x + bounds.w - 8 - mark.w;
  const maxY = bounds.y + bounds.h - 8 - mark.h;
  if (maxX < minX || maxY < minY) return null;
  for (const pad of [18, 12]) {
    let best: { box: Box; score: number } | null = null;
    for (let y = minY; y <= maxY; y += 16) {
      for (let x = minX; x <= maxX; x += 20) {
        const box = { x, y, w: mark.w, h: mark.h };
        if (!boxClearIndexed(box, mark, placed, indexed, pad)) continue;
        const lead = leadLength(box, mark);
        if (lead > 260) continue;
        const dx = Math.abs(box.x + box.w / 2 - mark.ax);
        const above = box.y + box.h < mark.ay ? 0 : 24;
        const score = lead * 2 + dx * 0.2 + above;
        if (!best || score < best.score) best = { box, score };
      }
    }
    if (best) return best.box;
  }
  return null;
}

function searchClampedSlots(
  mark: MarkerInput,
  placed: readonly { box: Box }[],
  segments: readonly MarkerSegment[],
  bounds: Box,
  linePad: number,
  maxLead: number,
  avoidX: number | null,
): Box | null {
  const found = scan(true);
  if (found) return found;
  return avoidX == null ? null : scan(false);

  function scan(respectAvoid: boolean): Box | null {
    if (mark.w > bounds.w - 16 || mark.h > bounds.h - 16) return null;
    for (const gap of [16, 28, 44, 72, 108]) {
      for (const side of sideOrder(mark.kind, mark.ax, mark.ay, bounds)) {
        const origin = slotOrigin(side, mark.ax, mark.ay, mark.w, mark.h, gap);
        const box = clampBox({ x: origin.x, y: origin.y, w: mark.w, h: mark.h }, bounds, 8);
        if (respectAvoid && avoidX != null && coversX(box, avoidX)) continue;
        const edge = nearestEdge(box.x, box.y, box.w, box.h, mark.ax, mark.ay);
        if (Math.hypot(edge.x - mark.ax, edge.y - mark.ay) > maxLead) continue;
        if (!boxClear(box, mark, placed, segments, linePad)) continue;
        return box;
      }
    }
    return null;
  }
}

function clampBox(box: Box, bounds: Box, margin: number): Box {
  const minX = bounds.x + margin;
  const minY = bounds.y + margin;
  const maxX = bounds.x + bounds.w - margin - box.w;
  const maxY = bounds.y + bounds.h - margin - box.h;
  return {
    x: Math.min(Math.max(box.x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(box.y, minY), Math.max(minY, maxY)),
    w: box.w,
    h: box.h,
  };
}

function searchNearSlots(
  mark: MarkerInput,
  placed: readonly { box: Box }[],
  segments: readonly MarkerSegment[],
  bounds: Box,
  linePad: number,
  maxLead: number,
  avoidX: number | null,
): Box | null {
  const found = scan(true);
  if (found) return found;
  return avoidX == null ? null : scan(false);

  function scan(respectAvoid: boolean): Box | null {
    for (const gap of [16, 28, 44, 72]) {
      for (const side of sideOrder(mark.kind, mark.ax, mark.ay, bounds)) {
        const origin = slotOrigin(side, mark.ax, mark.ay, mark.w, mark.h, gap);
        const box = { x: origin.x, y: origin.y, w: mark.w, h: mark.h };
        if (!boxInside(box, bounds, 6)) continue;
        if (respectAvoid && avoidX != null && coversX(box, avoidX)) continue;
        const edge = nearestEdge(box.x, box.y, box.w, box.h, mark.ax, mark.ay);
        if (Math.hypot(edge.x - mark.ax, edge.y - mark.ay) > maxLead) continue;
        if (!boxClear(box, mark, placed, segments, linePad)) continue;
        return box;
      }
    }
    return null;
  }
}

function searchCalloutGrid(
  mark: MarkerInput,
  placed: readonly { box: Box }[],
  segments: readonly IndexedSegment[],
  bounds: Box,
  linePad: number,
): Box | null {
  const margin = 6;
  const minX = bounds.x + margin;
  const minY = bounds.y + margin;
  const maxX = bounds.x + bounds.w - margin - mark.w;
  const maxY = bounds.y + bounds.h - margin - mark.h;
  if (maxX < minX || maxY < minY) return null;
  const candidates: { box: Box; lead: number }[] = [];
  for (const y of axisSamples(minY, maxY, 24)) {
    for (const x of axisSamples(minX, maxX, 24)) {
      const box = { x, y, w: mark.w, h: mark.h };
      const edge = nearestEdge(box.x, box.y, box.w, box.h, mark.ax, mark.ay);
      candidates.push({ box, lead: Math.hypot(edge.x - mark.ax, edge.y - mark.ay) });
    }
  }
  candidates.sort((a, b) => a.lead - b.lead);
  for (const candidate of candidates) {
    if (boxClearIndexed(candidate.box, mark, placed, segments, linePad)) return candidate.box;
  }
  return null;
}

function tightenCallout(
  start: Box,
  mark: MarkerInput,
  placed: readonly { box: Box }[],
  segments: readonly IndexedSegment[],
  bounds: Box,
  linePad: number,
): Box {
  let current = start;
  let lead = leadLength(current, mark);
  for (let step = 0; step < 36; step += 1) {
    const dx = mark.ax - (current.x + current.w / 2);
    const dy = mark.ay - (current.y + current.h / 2);
    const length = Math.hypot(dx, dy);
    if (length < 6) break;
    const next = { x: current.x + (dx / length) * 6, y: current.y + (dy / length) * 6, w: current.w, h: current.h };
    if (!boxInside(next, bounds, 6)) break;
    const nextLead = leadLength(next, mark);
    if (nextLead >= lead - 0.25) break;
    if (!boxClearIndexed(next, mark, placed, segments, linePad)) break;
    current = next;
    lead = nextLead;
  }
  return current;
}

function axisSamples(min: number, max: number, step: number): number[] {
  const values: number[] = [];
  for (let value = min; value <= max + 1e-6; value += step) values.push(Math.min(value, max));
  const last = values[values.length - 1];
  if (last === undefined || max - last > 0.5) values.push(max);
  return values;
}

function leadLength(box: Box, mark: MarkerInput): number {
  const edge = nearestEdge(box.x, box.y, box.w, box.h, mark.ax, mark.ay);
  return Math.hypot(edge.x - mark.ax, edge.y - mark.ay);
}

function boxClear(
  box: Box,
  mark: MarkerInput,
  placed: readonly { box: Box }[],
  segments: readonly MarkerSegment[],
  linePad: number,
): boolean {
  if (placed.some((item) => overlaps(box, item.box, 12))) return false;
  if (guideTooClose(box, segments)) return false;
  if (segments.some((segment) => segmentHitsRect(segment.x1, segment.y1, segment.x2, segment.y2, box, linePad))) return false;
  const edge = nearestEdge(box.x, box.y, box.w, box.h, mark.ax, mark.ay);
  return !placed.some((item) => segmentHitsRect(edge.x, edge.y, mark.ax, mark.ay, item.box, 4));
}

/** The open-price guide runs the full plot. Labels sit clear of it, not in the gap under a dash. */
function guideTooClose(box: Box, segments: readonly MarkerSegment[]): boolean {
  const gap = 28;
  for (const segment of segments) {
    if (Math.abs(segment.y1 - segment.y2) > 1.5) continue;
    if (Math.abs(segment.x2 - segment.x1) < 240) continue;
    const y = (segment.y1 + segment.y2) / 2;
    const dist = box.y >= y ? box.y - y : y - (box.y + box.h);
    if (dist < gap) return true;
  }
  return false;
}

function boxClearIndexed(
  box: Box,
  mark: MarkerInput,
  placed: readonly { box: Box }[],
  segments: readonly IndexedSegment[],
  linePad: number,
): boolean {
  if (placed.some((item) => overlaps(box, item.box, 12))) return false;
  if (guideTooClose(box, segments)) return false;
  if (hitsIndexed(box, segments, linePad)) return false;
  const edge = nearestEdge(box.x, box.y, box.w, box.h, mark.ax, mark.ay);
  return !placed.some((item) => segmentHitsRect(edge.x, edge.y, mark.ax, mark.ay, item.box, 4));
}

function indexSegments(segments: readonly MarkerSegment[]): IndexedSegment[] {
  return segments.map((segment) => ({
    ...segment,
    minX: Math.min(segment.x1, segment.x2),
    minY: Math.min(segment.y1, segment.y2),
    maxX: Math.max(segment.x1, segment.x2),
    maxY: Math.max(segment.y1, segment.y2),
  }));
}

function hitsIndexed(box: Box, segments: readonly IndexedSegment[], pad: number): boolean {
  const left = box.x - pad;
  const right = box.x + box.w + pad;
  const top = box.y - pad;
  const bottom = box.y + box.h + pad;
  for (const segment of segments) {
    if (segment.maxX < left || segment.minX > right || segment.maxY < top || segment.minY > bottom) continue;
    if (segmentHitsRect(segment.x1, segment.y1, segment.x2, segment.y2, box, pad)) return true;
  }
  return false;
}

function boxInside(box: Box, bounds: Box, margin: number): boolean {
  return (
    box.x >= bounds.x + margin &&
    box.y >= bounds.y + margin &&
    box.x + box.w <= bounds.x + bounds.w - margin &&
    box.y + box.h <= bounds.y + bounds.h - margin
  );
}

function toSegments(points: readonly Point[]): MarkerSegment[] {
  const segments: MarkerSegment[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    if (!prev || !next) continue;
    segments.push({ x1: prev.x, y1: prev.y, x2: next.x, y2: next.y });
  }
  return segments;
}

function measureMark(ctx: Ctx, mark: Mark): { w: number; h: number } {
  ctx.font = mark.boxed ? CALLOUT_FONT : LABEL_FONT;
  const textW = ctx.measureText(mark.text).width;
  if (mark.boxed) return { w: Math.min(PLOT.w - 32, textW + 40), h: 48 };
  return { w: textW + 12, h: 32 };
}

function sideOrder(kind: MarkKind, ax: number, ay: number, bounds: Box): SlotSide[] {
  const roomAbove = ay - bounds.y;
  const roomBelow = bounds.y + bounds.h - ay;
  const above: SlotSide[] = ['above', 'aboveLeft', 'aboveRight'];
  const below: SlotSide[] = ['below', 'belowLeft', 'belowRight'];
  const vertical = roomAbove >= roomBelow ? [...above, ...below] : [...below, ...above];
  if (kind === 'now') return ['aboveRight', 'belowRight', 'above', 'below', 'right', 'left', 'aboveLeft', 'belowLeft'];
  if (kind === 'peak') return ['above', 'aboveLeft', 'aboveRight', 'left', 'right', 'belowLeft', 'belowRight', 'below'];
  if (kind === 'low') return ['aboveRight', 'above', 'right', 'belowRight', 'below', 'aboveLeft', 'left', 'belowLeft'];
  if (kind === 'start') return ['above', 'aboveRight', 'below', 'belowRight', 'right', 'aboveLeft', 'left', 'belowLeft'];
  return [...vertical, 'left', 'right'];
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
  if (length < 10) return;
  const trim = Math.min(9, length * 0.3);
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

function overlaps(a: Box, b: Box, pad: number): boolean {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

function segmentHitsRect(x1: number, y1: number, x2: number, y2: number, box: Box, pad: number): boolean {
  const left = box.x - pad;
  const right = box.x + box.w + pad;
  const top = box.y - pad;
  const bottom = box.y + box.h + pad;
  if (x1 >= left && x1 <= right && y1 >= top && y1 <= bottom) return true;
  if (x2 >= left && x2 <= right && y2 >= top && y2 <= bottom) return true;
  return (
    segmentsCross(x1, y1, x2, y2, left, top, right, top) ||
    segmentsCross(x1, y1, x2, y2, right, top, right, bottom) ||
    segmentsCross(x1, y1, x2, y2, right, bottom, left, bottom) ||
    segmentsCross(x1, y1, x2, y2, left, bottom, left, top)
  );
}

function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const abx = bx - ax;
  const aby = by - ay;
  const cdx = dx - cx;
  const cdy = dy - cy;
  const denom = abx * cdy - aby * cdx;
  if (Math.abs(denom) < 1e-9) return false;
  const t = ((cx - ax) * cdy - (cy - ay) * cdx) / denom;
  const u = ((cx - ax) * aby - (cy - ay) * abx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
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
  // Same light wash for rises and declines. The tip fades so the fill has no end wall.
  const wash = run.above ? 0.11 : 0.05;
  const rgb = run.above ? '61,220,151' : '255,92,108';
  ctx.save();
  ctx.beginPath();
  traceCurve(ctx, run.points);
  ctx.lineTo(last.x, startY);
  ctx.lineTo(first.x, startY);
  ctx.closePath();
  const fade = 260;
  const gradient = ctx.createLinearGradient(last.x - fade, 0, last.x + 8, 0);
  gradient.addColorStop(0, `rgba(${rgb},${wash})`);
  gradient.addColorStop(0.72, `rgba(${rgb},${wash * 0.45})`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.restore();
}

function drawRun(ctx: Ctx, run: Run, alpha: number): void {
  if (run.points.length < 2) return;
  // Crisp core, one shared glow. Red uses the same layers as green.
  const layers = [
    { width: 16, alpha: alpha * 0.16 },
    { width: 7, alpha: alpha * 0.4 },
    { width: 3.25, alpha },
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

function drawOriginScar(ctx: Ctx, open: number, frame: number): void {
  const x = xAt(0);
  const y = yAt(open);
  const grow = easeInOut(Math.min(1, frame / Math.max(1, HOOK_END * 0.85)));
  ctx.save();
  ctx.setLineDash([2, 7]);
  ctx.strokeStyle = 'rgba(247,248,251,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 24 + grow * 96, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.fillStyle = INK;
  ctx.arc(x, y, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = '#141820';
  ctx.arc(x, y, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawHeadDot(ctx: Ctx, tip: Point, up: boolean): void {
  ctx.beginPath();
  ctx.fillStyle = up ? UP : DOWN;
  ctx.arc(tip.x, tip.y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = INK;
  ctx.arc(tip.x, tip.y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawExtremeDot(ctx: Ctx, animation: Animation, index: number, playhead: number): void {
  if (index < 0 || playhead < index) return;
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

function visualPrice(animation: Animation, index: number, playhead: number): number {
  const raw = sample(animation.prices, index);
  const smooth = sample(animation.smooth, index);
  const blend = Math.exp(-Math.abs(playhead - index) / 5);
  return smooth + (raw - smooth) * blend;
}

function buildView(prices: readonly number[], reveal: Float64Array) {
  const count = prices.length;
  const last = Math.max(1, count - 1);
  const full = fullDomain(prices);
  const yMin = new Float64Array(FRAME_COUNT);
  const yMax = new Float64Array(FRAME_COUNT);
  const windowLeft = new Float64Array(FRAME_COUNT);
  const windowRight = new Float64Array(FRAME_COUNT);
  const logMix = new Float64Array(FRAME_COUNT);
  const open = prices[0] ?? 0;
  const openSpan = Math.min(last, Math.max(8, last * 0.2));

  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const playhead = Math.max(0, Math.min(last, reveal[frame] ?? 0));
    const right = cameraRight(frame, playhead, last, openSpan);
    const raw = revealedRange(prices, 0, playhead);
    const current = sample(prices, playhead);
    const min = Math.min(raw.min, open, current);
    const max = Math.max(raw.max, open, current);
    const padded = padRange(min, max);
    windowLeft[frame] = 0;
    windowRight[frame] = right;
    if (frame >= PLAY_END) {
      const u = easeInOut(Math.min(1, (frame - PLAY_END) / (FPS * 0.7)));
      yMin[frame] = padded.lo + (full.lo - padded.lo) * u;
      yMax[frame] = padded.hi + (full.hi - padded.hi) * u;
    } else {
      yMin[frame] = padded.lo;
      yMax[frame] = padded.hi;
    }
    logMix[frame] = 0;
  }

  return { yMin, yMax, windowLeft, windowRight, logMix };
}

/**
 * The playhead is a time position. Until the path arrives, the window runs past it
 * so the axis keeps an open future. The final frames close on the last close.
 * The plot's right pad is applied on top of this window and never collapses.
 */
function cameraRight(frame: number, playhead: number, last: number, openSpan: number): number {
  const opened = Math.min(last, openSpan);
  if (frame >= PLAY_END) return last;
  if (frame < HOOK_END) {
    const u = easeInOut(frame / Math.max(1, HOOK_END - 1));
    return Math.max(1, opened * (0.16 + 0.84 * u));
  }
  if (frame < ESTABLISH_END) return Math.max(1, opened);
  return Math.min(last, Math.max(opened, playhead / 0.58));
}

function revealedRange(prices: readonly number[], left: number, playhead: number): { min: number; max: number } {
  const start = Math.max(0, Math.floor(left));
  const end = Math.min(prices.length - 1, Math.max(start, Math.floor(playhead + 1e-9)));
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

function revealedCloses(
  prices: readonly number[],
  dates: readonly string[],
  playhead: number,
): { prices: number[]; dates: string[]; price: number; date: string } {
  const last = Math.max(0, prices.length - 1);
  const clamped = Math.max(0, Math.min(last, playhead));
  const end = Math.min(last, Math.floor(clamped + 1e-9));
  const price = roundMoney(sample(prices, clamped));
  const outPrices: number[] = [];
  const outDates: string[] = [];
  for (let i = 0; i <= end; i += 1) {
    outPrices.push(roundMoney(prices[i] ?? 0));
    outDates.push(dates[i] ?? '');
  }
  if (clamped - end > 1e-4 && end < last) {
    outPrices.push(price);
    outDates.push(dates[end] ?? '');
  } else if (outPrices.length > 0) {
    outPrices[outPrices.length - 1] = price;
  }
  const dateIndex = Math.min(last, Math.max(0, Math.round(clamped)));
  return { prices: outPrices, dates: outDates, price, date: dates[dateIndex] ?? dates[end] ?? '' };
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

function indexOnDate(animation: Animation, date: string): number {
  if (!date) return -1;
  return animation.dates.indexOf(date);
}

function sample(prices: readonly number[], index: number): number {
  const i0 = Math.max(0, Math.min(prices.length - 1, Math.floor(index)));
  const i1 = Math.min(prices.length - 1, i0 + 1);
  const span = index - i0;
  const a = prices[i0] ?? 0;
  const b = prices[i1] ?? a;
  return a + (b - a) * span;
}

export function indexToX(index: number, left: number, right: number): number {
  const span = Math.max(1e-6, right - left);
  const rightPad = PLOT.w * RIGHT_PAD_RATIO;
  return PLOT.x + LEFT_PAD + ((index - left) / span) * (PLOT.w - LEFT_PAD - rightPad);
}

function xAt(index: number): number {
  return indexToX(index, viewLeft, viewRight);
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

function windowTag(start: string, end: string): string {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  const days = Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.round((to - from) / 86_400_000)) : 0;
  if (days < 45) return `${Math.max(1, days)}D`;
  if (days < 330) return `${Math.max(1, Math.round(days / 30.4375))}M`;
  return `${Math.max(1, Math.round(days / 365.25))}Y`;
}

function fitLineSize(ctx: Ctx, text: string, maxWidth: number, start: number, floor: number, weight: string): number {
  let size = start;
  while (size > floor) {
    ctx.font = `${weight} ${size}px Geist, sans-serif`;
    if (measureTabular(ctx, text) <= maxWidth) return size;
    size -= 1;
  }
  ctx.font = `${weight} ${floor}px Geist, sans-serif`;
  return floor;
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

function titleWidth(ctx: Ctx, ticker: string, name: string, size: number): number {
  const nameSize = Math.max(16, Math.round(size * 0.68));
  ctx.font = `600 ${size}px Geist, sans-serif`;
  const tickerWidth = ctx.measureText(ticker).width;
  ctx.font = `500 ${nameSize}px Geist, sans-serif`;
  return tickerWidth + ctx.measureText(`  ${name}`).width;
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
