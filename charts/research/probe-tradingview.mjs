import { writeFileSync, readFileSync } from 'node:fs';
import {
  getCandles, getQuote, getScreener, getTechnicalAnalysis,
  searchMarkets, getIndicatorData,
} from '@mathieuc/tradingview/data';

const report = {
  assessedAt: new Date().toISOString(),
  package: '@mathieuc/tradingview',
  version: JSON.parse(readFileSync(new URL('./node_modules/@mathieuc/tradingview/package.json', import.meta.url))).version,
  node: process.version,
  authentication: 'anonymous; no cookies or account credentials supplied',
  probes: [],
};
const options = () => ({ timeoutMs: 10000, signal: AbortSignal.timeout(10000) });
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
async function probe(name, operation) {
  const started = Date.now();
  try {
    const summary = await operation();
    const result = { name, status: 'passed', elapsedMs: Date.now() - started, summary };
    report.probes.push(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    const result = { name, status: 'failed', elapsedMs: Date.now() - started, code: error.code ?? error.name, message: error.message };
    report.probes.push(result);
    console.log(JSON.stringify(result));
  }
}

await probe('search', async () => {
  const rows = await searchMarkets('COINBASE:BTCUSD', { type: 'crypto', signal: AbortSignal.timeout(10000) });
  requireThat(rows.some(row => row.id === 'COINBASE:BTCUSD'), 'Exact requested instrument was absent');
  return { query: 'COINBASE:BTCUSD', count: rows.length, exactMatch: true };
});
await probe('hourly-candles', async () => {
  const candles = await getCandles({ symbol: 'COINBASE:BTCUSD', timeframe: '60', count: 20, ...options() });
  requireThat(candles.length === 20, 'Expected 20 bars');
  requireThat(candles.every((c, i) => [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
    && c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high)
    && (i === 0 || c.time > candles[i - 1].time)), 'Invalid bar schema, ordering or price bounds');
  return { symbol: 'COINBASE:BTCUSD', timeframe: '60', count: candles.length,
    firstBar: candles[0].time, lastBar: candles.at(-1).time, schemaAndOrderingValid: true };
});
await probe('quote', async () => {
  const quote = await getQuote({ symbol: 'BINANCE:BTCUSDT', ...options() });
  requireThat(Number.isFinite(quote.lp), 'Missing finite last price');
  return { symbol: 'BINANCE:BTCUSDT', hasFiniteLastPrice: true,
    updateMode: quote.update_mode ?? null, quoteFields: Object.keys(quote).length };
});
await probe('screener', async () => {
  const page = await getScreener({ market: 'crypto',
    symbols: ['BINANCE:BTCUSDT', 'COINBASE:BTCUSD'],
    columns: ['name', 'close', 'volume', 'update_mode', 'Recommend.All', 'RSI'], range: [0, 2],
  }, { signal: AbortSignal.timeout(10000) });
  requireThat(page.rows.length > 0, 'Expected at least one matching row');
  return { totalCount: page.totalCount, rows: page.rows.map(row => ({ symbol: row.symbol,
    updateMode: row.values.update_mode, populatedFields: Object.keys(row.values).filter(key => row.values[key] !== null) })) };
});
await probe('technical-ratings', async () => {
  const ratings = await getTechnicalAnalysis('BINANCE:BTCUSDT', { signal: AbortSignal.timeout(10000) });
  requireThat(ratings && Object.keys(ratings).length > 0, 'Expected ratings');
  return { symbol: 'BINANCE:BTCUSDT', timeframes: Object.keys(ratings),
    allValuesFinite: Object.values(ratings).every(row => Object.values(row).every(Number.isFinite)) };
});
await probe('anonymous-built-in-study', async () => {
  const study = await getIndicatorData({ symbol: 'BINANCE:BTCUSDT', timeframe: 'D', count: 20,
    indicator: 'Volume@tv-basicstudies-241', ...options() });
  requireThat(study.values.length > 0, 'Expected built-in study rows');
  return { indicator: 'Volume@tv-basicstudies-241', candles: study.candles.length, studyRows: study.values.length };
});

report.limitations = ['One bounded anonymous run on one host; not a service guarantee.',
  'No authenticated Pine, account watchlists, strategies, UI parity, prolonged streams or market-data entitlements verified.',
  'No exchange cross-check or independent price accuracy verification performed.'];
writeFileSync(new URL('./probe-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.probes.some(result => result.status === 'failed') ? 1 : 0;
