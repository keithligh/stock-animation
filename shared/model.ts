import type { Bar } from './parse';

export interface SeriesInput {
  displaySymbol: string;
  yahooSymbol: string;
  name: string;
  currency: string;
  bars: readonly Bar[];
}

export interface AlignedSeries {
  displaySymbol: string;
  yahooSymbol: string;
  name: string;
  currency: string;
  /** Close aligned to `dates`. Null before the listing date. Later gaps are forward-filled. */
  prices: (number | null)[];
  /** `price / firstPrice - 1`. Null wherever `prices` is null, or when the baseline is 0. */
  changes: (number | null)[];
}

export interface RankedSeries {
  displaySymbol: string;
  /** Ending percent change. Null when the series never prints a price. */
  change: number | null;
  rank: number;
}

export type ChartMode = 'price' | 'change';

export interface ChartModel {
  /** One ticker keeps its own currency. Two or more compare percent change. */
  mode: ChartMode;
  dates: string[];
  series: AlignedSeries[];
  ranking: RankedSeries[];
}

/** `close / baseline - 1`. Baseline must be finite and non-zero. */
export function percentChange(close: number, baseline: number): number {
  if (!Number.isFinite(close) || !Number.isFinite(baseline) || baseline === 0) {
    throw new Error('percent change needs finite prices and a non-zero baseline');
  }
  return close / baseline - 1;
}

/**
 * Union the trading days, forward-fill each series after it starts, and
 * rebase every line to its own first close. No FX conversion.
 */
export function buildModel(inputs: readonly SeriesInput[]): ChartModel {
  if (inputs.length < 1 || inputs.length > 4) {
    throw new Error('chart needs 1 to 4 series');
  }
  const dateSet = new Set<string>();
  const columns = inputs.map((input) => {
    const prices = new Map<string, number>();
    for (const bar of input.bars) {
      prices.set(bar.date, bar.close);
      dateSet.add(bar.date);
    }
    return { input, prices };
  });
  const dates = [...dateSet].sort();
  const series = columns.map(({ input, prices }) => alignSeries(input, prices, dates));
  return {
    mode: chartMode(inputs.length),
    dates,
    series,
    ranking: rankSeries(series),
  };
}

export function valueAt(series: AlignedSeries, mode: ChartMode, index: number): number | null {
  switch (mode) {
    case 'price':
      return series.prices[index] ?? null;
    case 'change':
      return series.changes[index] ?? null;
    default: {
      const never: never = mode;
      throw new Error(`unknown chart mode ${never}`);
    }
  }
}

function chartMode(count: number): ChartMode {
  return count === 1 ? 'price' : 'change';
}

function alignSeries(input: SeriesInput, pricesByDate: Map<string, number>, dates: string[]): AlignedSeries {
  const prices: (number | null)[] = [];
  let last: number | null = null;
  let started = false;
  for (const date of dates) {
    const printed = pricesByDate.get(date);
    if (printed !== undefined) {
      last = printed;
      started = true;
      prices.push(printed);
      continue;
    }
    if (started && last !== null) {
      prices.push(last);
      continue;
    }
    prices.push(null);
  }
  const baseline = prices.find((price) => price !== null) ?? null;
  const changes = prices.map((price) => {
    if (price === null || baseline === null || baseline === 0) return null;
    return percentChange(price, baseline);
  });
  return {
    displaySymbol: input.displaySymbol,
    yahooSymbol: input.yahooSymbol,
    name: input.name,
    currency: input.currency,
    prices,
    changes,
  };
}

function rankSeries(series: readonly AlignedSeries[]): RankedSeries[] {
  const scored = series.map((item, index) => ({
    displaySymbol: item.displaySymbol,
    change: item.changes[item.changes.length - 1] ?? null,
    index,
  }));
  scored.sort((a, b) => {
    if (a.change === null && b.change === null) return a.index - b.index;
    if (a.change === null) return 1;
    if (b.change === null) return -1;
    if (a.change !== b.change) return b.change - a.change;
    return a.index - b.index;
  });
  return scored.map((item, index) => ({
    displaySymbol: item.displaySymbol,
    change: item.change,
    rank: index + 1,
  }));
}
