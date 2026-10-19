import { describe, expect, it } from 'vitest';
import {
  canonicalizeTicker,
  isRelaySymbol,
  mapRelaySymbol,
  symbolsMatch,
  toYahooSymbol,
} from '../shared/symbols';

describe('symbol mapping', () => {
  it('zero-pads HK codes to 4 digits', () => {
    expect(mapRelaySymbol('700.HK')).toEqual({ display: '0700.HK', yahoo: '0700.HK', market: 'HK' });
    expect(mapRelaySymbol('0700.hk')).toEqual({ display: '0700.HK', yahoo: '0700.HK', market: 'HK' });
    expect(toYahooSymbol('00700.HK')).toBe('0700.HK');
    expect(toYahooSymbol('1.HK')).toBe('0001.HK');
  });

  it('keeps a real 5-digit HK code', () => {
    expect(toYahooSymbol('80000.HK')).toBe('80000.HK');
  });

  it('maps US tickers and class shares', () => {
    expect(mapRelaySymbol('NVDA.US')).toEqual({ display: 'NVDA.US', yahoo: 'NVDA', market: 'US' });
    expect(mapRelaySymbol('BRK.B.US')).toEqual({ display: 'BRK.B.US', yahoo: 'BRK-B', market: 'US' });
    expect(mapRelaySymbol('BRK-B.US')).toEqual({ display: 'BRK.B.US', yahoo: 'BRK-B', market: 'US' });
  });

  it('rejects symbols the relay must not fetch', () => {
    expect(isRelaySymbol('NVDA')).toBe(false);
    expect(isRelaySymbol('BRK.B')).toBe(false);
    expect(isRelaySymbol('../etc')).toBe(false);
    expect(isRelaySymbol('0700.HK/extra')).toBe(false);
    expect(toYahooSymbol('NVDA')).toBeNull();
  });

  it('canonicalizes what a person types', () => {
    expect(canonicalizeTicker('nvda')).toBe('NVDA.US');
    expect(canonicalizeTicker('BRK.B')).toBe('BRK.B.US');
    expect(canonicalizeTicker('BRK-B')).toBe('BRK.B.US');
    expect(canonicalizeTicker('700')).toBe('0700.HK');
    expect(canonicalizeTicker('')).toBeNull();
    expect(canonicalizeTicker('!!!')).toBeNull();
  });

  it('matches a dropped file by the Yahoo symbol inside it', () => {
    expect(symbolsMatch('0700.HK', '0700.HK')).toBe(true);
    expect(symbolsMatch('NVDA.US', 'NVDA')).toBe(true);
    expect(symbolsMatch('BRK.B.US', 'BRK-B')).toBe(true);
    expect(symbolsMatch('NVDA.US', '0700.HK')).toBe(false);
  });
});
