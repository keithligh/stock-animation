export const FPS = 60;
/** 30 seconds at 60 fps. */
export const FRAME_COUNT = FPS * 30;
/** Answer title over the faint full line. */
export const HOOK_END = FPS * 2;
/** Rewind back to the first close. */
export const REWIND_END = HOOK_END + Math.round(FPS * 1.5);
/** Hold on the ticker, the start date, and the starting share price. */
export const ESTABLISH_END = REWIND_END + FPS;
/** Pull-back end card. */
export const PLAY_END = FRAME_COUNT - FPS * 3;

export const LEAD_FRAMES = Math.round(FPS * 0.5);
export const CALLOUT_FRAMES = FPS * 2;

const DWELL = 1.8;
const DWELL_RADIUS = 18;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface RangeSoFar {
  high: number;
  highDate: string;
  low: number;
  lowDate: string;
}

export interface DrawdownSoFar {
  /** Worst peak-to-trough fraction so far. Zero or negative. */
  depth: number;
  /** Fraction from the running peak to the current price. Zero or negative. */
  current: number;
  peak: number;
  trough: number;
  peakDate: string;
  troughDate: string;
}

export interface GrowthSoFar {
  annualized: boolean;
  rate: number;
  years: number;
}

export interface YearMark {
  year: number;
  fraction: number;
  startIndex: number;
}

export type EventKind = 'drawdown' | 'recovery' | 'up' | 'down' | 'dividend';

export interface MarketEvent {
  kind: EventKind;
  index: number;
  anchor: number;
  priority: number;
  score: number;
  text: string;
}

export interface VisibleCallout {
  kind: EventKind;
  text: string;
  anchor: number;
  tone: 'up' | 'down' | 'neutral';
  startFrame: number;
  endFrame: number;
  arriveFrame: number;
}

export function rangeSoFar(prices: readonly number[], dates: readonly string[], endIndex: number): RangeSoFar {
  const last = clampIndex(prices.length, endIndex);
  let high = prices[0] ?? 0;
  let low = high;
  let highAt = 0;
  let lowAt = 0;
  for (let i = 1; i <= last; i += 1) {
    const price = prices[i] ?? high;
    if (price > high) {
      high = price;
      highAt = i;
    }
    if (price < low) {
      low = price;
      lowAt = i;
    }
  }
  return { high, highDate: dates[highAt] ?? '', low, lowDate: dates[lowAt] ?? '' };
}

export function maxDrawdownSoFar(prices: readonly number[], dates: readonly string[], endIndex: number): DrawdownSoFar {
  const last = clampIndex(prices.length, endIndex);
  let peak = prices[0] ?? 0;
  let peakAt = 0;
  let runTrough = peak;
  let runTroughAt = 0;
  let depth = 0;
  let worstPeak = peak;
  let worstTrough = peak;
  let worstPeakAt = 0;
  let worstTroughAt = 0;
  for (let i = 0; i <= last; i += 1) {
    const price = prices[i] ?? peak;
    if (price >= peak) {
      peak = price;
      peakAt = i;
      runTrough = price;
      runTroughAt = i;
    } else if (price < runTrough) {
      runTrough = price;
      runTroughAt = i;
    }
    const runDepth = peak === 0 ? 0 : runTrough / peak - 1;
    if (runDepth < depth) {
      depth = runDepth;
      worstPeak = peak;
      worstTrough = runTrough;
      worstPeakAt = peakAt;
      worstTroughAt = runTroughAt;
    }
  }
  const lastPrice = prices[last] ?? peak;
  const current = peak === 0 ? 0 : Math.min(0, lastPrice / peak - 1);
  return {
    depth,
    current,
    peak: worstPeak,
    trough: worstTrough,
    peakDate: dates[worstPeakAt] ?? '',
    troughDate: dates[worstTroughAt] ?? '',
  };
}

export function growthSoFar(startPrice: number, endPrice: number, startDate: string, endDate: string): GrowthSoFar {
  const years = Math.max(0, daysBetween(startDate, endDate) / 365.25);
  const plain = startPrice === 0 ? 0 : endPrice / startPrice - 1;
  if (years < 1) return { annualized: false, rate: plain, years };
  if (startPrice <= 0 || endPrice <= 0) return { annualized: true, rate: -1, years };
  return { annualized: true, rate: (endPrice / startPrice) ** (1 / years) - 1, years };
}

export function yearChapter(prices: readonly number[], dates: readonly string[], index: number): YearMark {
  const end = clampIndex(prices.length, index);
  const yearText = dates[end]?.slice(0, 4) ?? '';
  let start = end;
  while (start > 0 && (dates[start - 1]?.slice(0, 4) ?? '') === yearText) start -= 1;
  const baseline = start > 0 ? (prices[start - 1] ?? prices[start] ?? 0) : (prices[0] ?? 0);
  const price = prices[end] ?? baseline;
  return {
    year: Number(yearText) || 0,
    fraction: baseline === 0 ? 0 : price / baseline - 1,
    startIndex: start,
  };
}

export function yearBoundaries(dates: readonly string[]): number[] {
  const indexes: number[] = [];
  let previous = '';
  for (let i = 0; i < dates.length; i += 1) {
    const year = dates[i]?.slice(0, 4) ?? '';
    if (!year || year === previous) continue;
    indexes.push(i);
    previous = year;
  }
  return indexes;
}

export function detectEvents(
  prices: readonly number[],
  dates: readonly string[],
  dividends: readonly { date: string; amount: number }[],
  currency: string,
): MarketEvent[] {
  const events: MarketEvent[] = [];
  const count = Math.min(prices.length, dates.length);
  if (count < 2) return events;

  let peak = 0;
  let trough = 0;
  for (let i = 1; i < count; i += 1) {
    const price = prices[i] ?? 0;
    const peakPrice = prices[peak] ?? 0;
    const troughPrice = prices[trough] ?? 0;
    if (price >= peakPrice) {
      pushDrawdown(events, prices, dates, peak, trough, i, currency);
      peak = i;
      trough = i;
    } else if (price < troughPrice) {
      trough = i;
    }
  }
  pushDrawdown(events, prices, dates, peak, trough, null, currency);
  pushStartRecoveries(events, prices, dates, currency);
  pushBiggestDays(events, prices, dates, currency);
  pushDividends(events, prices, dates, dividends, currency);

  events.sort((a, b) => a.index - b.index || a.priority - b.priority || b.score - a.score);
  const deduped: MarketEvent[] = [];
  for (const event of events) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.index === event.index && previous.kind === 'recovery' && event.kind === 'recovery') {
      continue;
    }
    deduped.push(event);
  }
  return deduped;
}

export function slowIndexes(events: readonly MarketEvent[]): number[] {
  const ranked = events
    .filter((event) => event.kind !== 'dividend' && event.score > 0)
    .slice()
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const picked: number[] = [];
  for (const event of ranked) {
    if (picked.length === 2) break;
    if (picked.includes(event.index)) continue;
    picked.push(event.index);
  }
  return picked;
}

export function playheadSeries(count: number, slowAt: readonly number[]): Float64Array {
  const reveal = new Float64Array(FRAME_COUNT);
  const last = Math.max(0, count - 1);
  if (count <= 1) return reveal;
  const weights = stepWeights(count, slowAt);
  const prefix = new Float64Array(weights.length + 1);
  for (let i = 0; i < weights.length; i += 1) prefix[i + 1] = (prefix[i] ?? 0) + (weights[i] ?? 1);
  const playSpan = Math.max(1, PLAY_END - ESTABLISH_END - 1);
  const rewindSpan = Math.max(1, REWIND_END - HOOK_END - 1);
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    if (frame < HOOK_END) {
      reveal[frame] = last;
      continue;
    }
    if (frame < REWIND_END) {
      const u = (frame - HOOK_END) / rewindSpan;
      reveal[frame] = last * (1 - easeInOut(u));
      continue;
    }
    if (frame < ESTABLISH_END) {
      reveal[frame] = 0;
      continue;
    }
    if (frame >= PLAY_END - 1) {
      reveal[frame] = last;
      continue;
    }
    const u = (frame - ESTABLISH_END) / playSpan;
    reveal[frame] = indexForUnit(u, prefix, weights, count);
  }
  return reveal;
}

export function placeCallouts(events: readonly MarketEvent[], series: Float64Array): VisibleCallout[] {
  const prepared = coalesceDividends(events);
  const story = prepared
    .filter((event) => event.kind !== 'dividend')
    .slice()
    .sort((a, b) => a.index - b.index || a.priority - b.priority);
  const dividends = prepared
    .filter((event) => event.kind === 'dividend')
    .slice()
    .sort((a, b) => a.index - b.index);
  const placed: VisibleCallout[] = [];
  let cursor = 0;
  for (const event of story) {
    const arrive = frameWhen(series, event.index);
    const natural = Math.max(ESTABLISH_END, arrive - leadFor(event.kind));
    const start = Math.max(natural, cursor);
    if (start >= PLAY_END) continue;
    if (start > natural + CALLOUT_FRAMES) continue;
    const end = Math.min(FRAME_COUNT, start + CALLOUT_FRAMES);
    if (end - start < 45) continue;
    placed.push(toCallout(event, start, end, arrive));
    cursor = end;
  }
  for (const event of dividends) {
    const arrive = frameWhen(series, event.index);
    if (arrive >= PLAY_END) continue;
    const end = Math.min(FRAME_COUNT, arrive + CALLOUT_FRAMES);
    if (end - arrive < 45) continue;
    if (placed.some((item) => arrive < item.endFrame && end > item.startFrame)) continue;
    placed.push(toCallout(event, arrive, end, arrive));
  }
  placed.sort((a, b) => a.startFrame - b.startFrame);
  return placed;
}

export function activeCallout(schedule: readonly VisibleCallout[], frame: number): VisibleCallout | null {
  return schedule.find((item) => frame >= item.startFrame && frame < item.endFrame) ?? null;
}

export function zoomSeries(schedule: readonly VisibleCallout[]): Float64Array {
  const zoom = new Float64Array(FRAME_COUNT);
  let value = 1;
  let velocity = 0;
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const beat = schedule.some(
      (item) => item.kind !== 'dividend' && frame >= item.startFrame && frame < item.endFrame,
    );
    const target = frame >= PLAY_END ? 0.978 : beat ? 1.036 : 1;
    const step = stepSpring(value, velocity, target, 1 / FPS, 5.5);
    value = step.value;
    velocity = step.velocity;
    zoom[frame] = value;
  }
  return zoom;
}

/** Critically damped approach from 0 to 1. Starts and ends at rest, never overshoots. */
export function damp(seconds: number, omega = 14): number {
  if (seconds <= 0) return 0;
  const x = omega * seconds;
  return Math.min(1, 1 - (1 + x) * Math.exp(-x));
}

export function stepSpring(
  value: number,
  velocity: number,
  target: number,
  dt: number,
  omega: number,
): { value: number; velocity: number } {
  const acceleration = -2 * omega * velocity - omega * omega * (value - target);
  const nextVelocity = velocity + acceleration * dt;
  const next = value + nextVelocity * dt;
  if ((value - target) * (next - target) < 0) return { value: target, velocity: 0 };
  if (Math.abs(next - target) < 1e-4 && Math.abs(nextVelocity) < 1e-3) return { value: target, velocity: 0 };
  return { value: next, velocity: nextVelocity };
}

export function easeInOut(unit: number): number {
  const t = Math.max(0, Math.min(1, unit));
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function hookPlate(frame: number): number {
  const fadeStart = HOOK_END - 10;
  const fadeEnd = HOOK_END + 20;
  if (frame <= fadeStart) return 1;
  if (frame >= fadeEnd) return 0;
  return 1 - easeInOut((frame - fadeStart) / (fadeEnd - fadeStart));
}

export function formatPrice(currency: string, value: number): string {
  const body = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return signedMoney(currency, value, body);
}

export function formatSignedPrice(currency: string, value: number): string {
  const body = formatPrice(currency, Math.abs(value));
  if (value > 0.000001) return `+${body}`;
  if (value < -0.000001) return `−${body}`;
  return body;
}

export function formatWhole(currency: string, value: number): string {
  const rounded = Math.round(value);
  const amount = Math.abs(rounded) < 1 ? 0 : Math.abs(rounded);
  return signedMoney(currency, rounded, amount.toLocaleString('en-US'));
}

export function formatSignedWhole(currency: string, value: number): string {
  const body = formatWhole(currency, Math.abs(value));
  if (value > 0.5) return `+${body}`;
  if (value < -0.5) return `−${body}`;
  return body;
}

export function formatPercent(fraction: number, digits = 1): string {
  const pct = fraction * 100;
  const text = Math.abs(pct).toFixed(digits);
  if (pct > 0) return `+${text}%`;
  if (pct < 0) return `−${text}%`;
  return `${(0).toFixed(digits)}%`;
}

export function formatRoundedPercent(fraction: number): string {
  const pct = Math.round(fraction * 100);
  if (pct > 0) return `+${pct}%`;
  if (pct < 0) return `−${Math.abs(pct)}%`;
  return '0%';
}

export function formatCompact(currency: string, value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) {
    const scaled = abs / 1000;
    const digits = scaled >= 100 ? 0 : 1;
    return signedMoney(currency, value, `${scaled.toFixed(digits)}k`);
  }
  return signedMoney(currency, value, Math.round(abs).toLocaleString('en-US'));
}

export function formatMonthStamp(iso: string): string {
  const [year, month] = iso.split('-');
  return `${monthName(month)} '${(year ?? '').slice(2)}`;
}

export function formatMonthYear(iso: string): string {
  const [year, month] = iso.split('-');
  return `${monthName(month)} ${year ?? ''}`;
}

export function formatLongDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${monthName(month)} ${Number(day) || 1}, ${year ?? ''}`;
}

export function formatShortMonth(iso: string): string {
  const [year, month] = iso.split('-');
  return `${monthName(month)} ${(year ?? '').slice(2)}`;
}

export function formatMonthDay(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${monthName(month)} ${Number(day) || 1}`;
}

function pushDrawdown(
  events: MarketEvent[],
  prices: readonly number[],
  dates: readonly string[],
  peak: number,
  trough: number,
  recovery: number | null,
  currency: string,
): void {
  if (trough === peak) return;
  const peakPrice = prices[peak] ?? 0;
  const troughPrice = prices[trough] ?? 0;
  const depth = peakPrice === 0 ? 0 : troughPrice / peakPrice - 1;
  if (depth > -0.2) return;
  const peakDate = dates[peak] ?? '';
  const troughDate = dates[trough] ?? '';
  events.push({
    kind: 'drawdown',
    index: trough,
    anchor: trough,
    priority: priorityFor('drawdown'),
    score: Math.abs(depth),
    text: `${formatSignedPrice(currency, troughPrice - peakPrice)} · ${formatRoundedPercent(depth)} ${inPhrase(peakDate, troughDate)}`,
  });
  if (recovery === null) return;
  events.push({
    kind: 'recovery',
    index: recovery,
    anchor: recovery,
    priority: priorityFor('recovery'),
    score: Math.abs(depth) * 0.9,
    text: `Recovered ${formatPrice(currency, peakPrice)} ${afterPhrase(peakDate, dates[recovery] ?? troughDate)}`,
  });
}

function pushStartRecoveries(
  events: MarketEvent[],
  prices: readonly number[],
  dates: readonly string[],
  currency: string,
): void {
  const open = prices[0] ?? 0;
  if (open === 0) return;
  let below = -1;
  let trough = open;
  for (let i = 1; i < prices.length; i += 1) {
    const price = prices[i] ?? open;
    if (price < open) {
      if (below < 0) {
        below = i;
        trough = price;
      } else if (price < trough) trough = price;
      continue;
    }
    if (below < 0) continue;
    const depth = trough / open - 1;
    const from = dates[below] ?? '';
    const to = dates[i] ?? '';
    if (daysBetween(from, to) >= 20 || depth <= -0.1) {
      events.push({
        kind: 'recovery',
        index: i,
        anchor: i,
        priority: priorityFor('recovery'),
        score: Math.max(0.12, Math.abs(depth)),
        text: `Back above ${formatPrice(currency, open)} ${afterPhrase(from, to)}`,
      });
    }
    below = -1;
    trough = open;
  }
}

function pushBiggestDays(events: MarketEvent[], prices: readonly number[], dates: readonly string[], currency: string): void {
  let upIndex = -1;
  let upChange = 0;
  let downIndex = -1;
  let downChange = 0;
  for (let i = 1; i < prices.length; i += 1) {
    const previous = prices[i - 1] ?? 0;
    const price = prices[i] ?? previous;
    if (previous === 0) continue;
    const change = price / previous - 1;
    if (change > upChange) {
      upChange = change;
      upIndex = i;
    }
    if (change < downChange) {
      downChange = change;
      downIndex = i;
    }
  }
  if (upIndex >= 0) {
    events.push({
      kind: 'up',
      index: upIndex,
      anchor: upIndex,
      priority: priorityFor('up'),
      score: upChange,
      text: `${formatSignedPrice(currency, (prices[upIndex] ?? 0) - (prices[upIndex - 1] ?? 0))} · ${formatRoundedPercent(upChange)} · ${formatLongDate(dates[upIndex] ?? '')}`,
    });
  }
  if (downIndex >= 0) {
    events.push({
      kind: 'down',
      index: downIndex,
      anchor: downIndex,
      priority: priorityFor('down'),
      score: Math.abs(downChange),
      text: `${formatSignedPrice(currency, (prices[downIndex] ?? 0) - (prices[downIndex - 1] ?? 0))} · ${formatRoundedPercent(downChange)} · ${formatLongDate(dates[downIndex] ?? '')}`,
    });
  }
}

function pushDividends(
  events: MarketEvent[],
  prices: readonly number[],
  dates: readonly string[],
  dividends: readonly { date: string; amount: number }[],
  currency: string,
): void {
  const open = prices[0] ?? 0;
  const first = dates[0] ?? '';
  const last = dates[dates.length - 1] ?? '';
  if (open <= 0 || dividends.length === 0) return;
  let total = 0;
  const ordered = dividends.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const dividend of ordered) {
    if (!(dividend.amount > 0) || dividend.date < first || dividend.date > last) continue;
    const index = dates.findIndex((date) => date >= dividend.date);
    if (index < 0) continue;
    total += dividend.amount;
    events.push({
      kind: 'dividend',
      index,
      anchor: index,
      priority: priorityFor('dividend'),
      score: 0,
      text: `Dividends ${formatPrice(currency, total)}`,
    });
  }
}

function coalesceDividends(events: readonly MarketEvent[]): MarketEvent[] {
  const story = events.filter((event) => event.kind !== 'dividend');
  const dividends = events.filter((event) => event.kind === 'dividend').slice().sort((a, b) => a.index - b.index);
  const merged: MarketEvent[] = [];
  for (const dividend of dividends) {
    const previous = merged[merged.length - 1];
    if (previous && dividend.index - previous.index <= 15) merged[merged.length - 1] = dividend;
    else merged.push(dividend);
  }
  return [...story, ...merged];
}

function toCallout(event: MarketEvent, start: number, end: number, arrive: number): VisibleCallout {
  return {
    kind: event.kind,
    text: event.text,
    anchor: event.anchor,
    tone: toneFor(event.kind),
    startFrame: start,
    endFrame: end,
    arriveFrame: arrive,
  };
}

function frameWhen(series: Float64Array, index: number): number {
  // The hook holds the last close, so arrival is the first play frame that reaches the bar.
  let lo = ESTABLISH_END;
  let hi = Math.max(ESTABLISH_END, series.length - 1);
  if ((series[lo] ?? 0) + 1e-6 >= index) return lo;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((series[mid] ?? 0) + 1e-6 >= index) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function leadFor(kind: EventKind): number {
  switch (kind) {
    case 'drawdown':
    case 'up':
    case 'down':
    case 'recovery':
      return LEAD_FRAMES;
    case 'dividend':
      return 0;
    default: {
      const never: never = kind;
      return never;
    }
  }
}

function priorityFor(kind: EventKind): number {
  switch (kind) {
    case 'drawdown':
      return 0;
    case 'recovery':
      return 1;
    case 'up':
    case 'down':
      return 2;
    case 'dividend':
      return 3;
    default: {
      const never: never = kind;
      return never;
    }
  }
}

function toneFor(kind: EventKind): 'up' | 'down' | 'neutral' {
  switch (kind) {
    case 'up':
    case 'recovery':
      return 'up';
    case 'down':
    case 'drawdown':
      return 'down';
    case 'dividend':
      return 'neutral';
    default: {
      const never: never = kind;
      return never;
    }
  }
}

function stepWeights(count: number, slowAt: readonly number[]): number[] {
  const steps = Math.max(0, count - 1);
  const weights = new Array<number>(steps).fill(1);
  for (const index of slowAt) {
    const from = Math.max(0, Math.floor(index) - DWELL_RADIUS);
    const to = Math.min(steps - 1, Math.ceil(index) + DWELL_RADIUS);
    for (let i = from; i <= to; i += 1) weights[i] = Math.max(weights[i] ?? 1, DWELL);
  }
  const edge = Math.min(10, Math.floor(steps / 8));
  for (let i = 0; i < edge; i += 1) {
    const ramp = 1 + (1 - i / Math.max(1, edge)) * 0.8;
    weights[i] = Math.max(weights[i] ?? 1, ramp);
    const tail = steps - 1 - i;
    weights[tail] = Math.max(weights[tail] ?? 1, ramp);
  }
  return weights;
}

function indexForUnit(unit: number, prefix: Float64Array, weights: readonly number[], count: number): number {
  const total = prefix[prefix.length - 1] ?? 1;
  const target = Math.max(0, Math.min(1, unit)) * total;
  let lo = 0;
  let hi = Math.max(0, weights.length - 1);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((prefix[mid + 1] ?? 0) >= target) hi = mid;
    else lo = mid + 1;
  }
  const start = prefix[lo] ?? 0;
  const span = weights[lo] || 1;
  return Math.min(count - 1, lo + (target - start) / span);
}

function inPhrase(from: string, to: string): string {
  return `in ${spanPhrase(from, to)}`;
}

function afterPhrase(from: string, to: string): string {
  return `after ${spanPhrase(from, to)}`;
}

function spanPhrase(from: string, to: string): string {
  const days = Math.max(0, daysBetween(from, to));
  if (days < 45) {
    const count = Math.max(1, days);
    return count === 1 ? '1 day' : `${count} days`;
  }
  const months = Math.max(1, Math.round(days / 30.4375));
  return months === 1 ? '1 month' : `${months} months`;
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

function clampIndex(count: number, index: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor(index)));
}

function monthName(month: string | undefined): string {
  return MONTHS[(Number(month) || 1) - 1] ?? 'Jan';
}

function signedMoney(currency: string, value: number, body: string): string {
  const sign = value < -0.000001 && body !== '0' ? '−' : '';
  if (currency === 'USD') return `${sign}$${body}`;
  if (currency === 'HKD') return `${sign}HK$${body}`;
  return `${sign}${body} ${currency}`.trim();
}
