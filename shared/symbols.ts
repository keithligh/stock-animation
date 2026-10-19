/** Relay path symbols: HK codes, or US tickers that already end in `.US`. */
const RELAY_SYMBOL = /^(?:\d{1,5}\.HK|[A-Z][A-Z0-9-]{0,9}(?:\.[A-Z])?\.US)$/;

export type Market = 'HK' | 'US';

export interface MappedSymbol {
  /** Canonical form stored in the URL: `0700.HK`, `NVDA.US`, `BRK.B.US`. */
  display: string;
  /** Yahoo chart symbol: `0700.HK`, `NVDA`, `BRK-B`. */
  yahoo: string;
  market: Market;
}

export function isRelaySymbol(input: string): boolean {
  return RELAY_SYMBOL.test(input.trim().toUpperCase());
}

/**
 * Map a validated relay symbol onto Yahoo's code.
 * HK numbers are zero-padded to 4 digits when they fit (`700.HK` → `0700.HK`).
 * A 5-digit code whose value is still under 10000 collapses the same way.
 * `BRK.B.US` and `BRK-B.US` both become `BRK-B`.
 */
export function toYahooSymbol(input: string): string | null {
  const mapped = mapRelaySymbol(input);
  return mapped?.yahoo ?? null;
}

export function toDisplaySymbol(input: string): string | null {
  const mapped = mapRelaySymbol(input);
  return mapped?.display ?? null;
}

export function mapRelaySymbol(input: string): MappedSymbol | null {
  const symbol = input.trim().toUpperCase();
  if (!isRelaySymbol(symbol)) return null;
  if (symbol.endsWith('.HK')) {
    const yahoo = formatHkSymbol(symbol.slice(0, -3));
    if (!yahoo) return null;
    return { display: yahoo, yahoo, market: 'HK' };
  }
  const body = symbol.slice(0, -3);
  const yahoo = body.includes('.') ? body.replace('.', '-') : body;
  const display = `${yahoo.replace(/-([A-Z])$/, '.$1')}.US`;
  if (!isRelaySymbol(display)) return null;
  return { display, yahoo, market: 'US' };
}

/**
 * Accept what a person types: `700.hk`, `NVDA`, `NVDA.US`, `BRK.B`, `BRK-B`.
 * Returns the canonical display symbol, or null when it cannot be a ticker.
 */
export function canonicalizeTicker(input: string): string | null {
  const symbol = input.trim().toUpperCase();
  if (!symbol || symbol.length > 16) return null;
  if (isRelaySymbol(symbol)) return toDisplaySymbol(symbol);
  if (/^\d{1,5}$/.test(symbol)) return toDisplaySymbol(`${symbol}.HK`);
  if (/^[A-Z][A-Z0-9-]{0,9}\.[A-Z]$/.test(symbol)) return toDisplaySymbol(`${symbol}.US`);
  if (/^[A-Z][A-Z0-9-]{0,9}$/.test(symbol)) {
    const asClass = symbol.replace(/-([A-Z])$/, '.$1');
    return toDisplaySymbol(`${asClass}.US`);
  }
  return null;
}

export function marketOfDisplay(display: string): Market | null {
  return mapRelaySymbol(display)?.market ?? null;
}

/** True when a Yahoo `meta.symbol` belongs to a canonical display ticker. */
export function symbolsMatch(display: string, yahooMetaSymbol: string): boolean {
  const mapped = mapRelaySymbol(display);
  if (!mapped) return false;
  return mapped.yahoo === yahooMetaSymbol.trim().toUpperCase();
}

function formatHkSymbol(digits: string): string | null {
  if (!/^\d{1,5}$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isInteger(value) || value <= 0) return null;
  if (value <= 9999) return `${String(value).padStart(4, '0')}.HK`;
  return `${String(value)}.HK`;
}
