export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Split-adjusted closes, plus dividend events when Yahoo sends them. */
export const YAHOO_CHART_QUERY = 'range=5y&interval=1d&events=div%7Csplit';

/** Fixed Yahoo chart URL. The symbol is already in Yahoo's form. */
export function yahooChartUrl(yahooSymbol: string): string {
  return `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?${YAHOO_CHART_QUERY}`;
}
