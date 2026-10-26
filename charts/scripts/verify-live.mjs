import assert from 'node:assert/strict';
import { createCharts } from '../src/service.mjs';

const service = createCharts();
const report = { testedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  node: process.version, nodeArgs: process.execArgv, provider: '@mathieuc/tradingview@4.1.0', authentication: 'anonymous', results: [] };
const checks = [
  ['symbols search', { query: 'COINBASE:BTCUSD', limit: 3 }, r => assert.ok(r.data.some(row => row.id === 'COINBASE:BTCUSD'))],
  ['symbol', { symbol: 'COINBASE:BTCUSD' }, r => assert.ok(r.data.timezone)],
  ['quotes', { symbols: ['BINANCE:BTCUSDT'] }, r => assert.equal(typeof r.data[0].last, 'number')],
  ['candles', { symbol: 'COINBASE:BTCUSD', timeframe: '1h', count: 20 }, r => assert.equal(r.data.length, 20)],
  ['technicals', { symbol: 'BINANCE:BTCUSDT' }, r => assert.equal(r.data.length, 8)],
  ['screener', { columns: ['name', 'close', 'volume', 'update_mode'], symbols: ['BINANCE:BTCUSDT'], limit: 1 }, r => assert.equal(r.data[0].symbol, 'BINANCE:BTCUSDT')],
  ['hotlist', { kind: 'gainers', market: 'crypto', limit: 3 }, r => { assert.ok(r.data.length > 0 && r.data.length <= 3); assert.ok(r.data.every(row => row.symbol)); }],
  ['indicators search', { query: 'RSI', limit: 3 }, r => { assert.ok(r.data.length > 0 && r.data.length <= 3); assert.ok(r.data.every(row => row.id)); }],
  ['indicator values', { symbol: 'BINANCE:BTCUSDT', indicator: 'Volume@tv-basicstudies-241', count: 10 }, r => assert.equal(r.values.length, 10)],
  ['stream quotes', { symbols: ['BINANCE:BTCUSDT'], seconds: 1, 'max-updates': 2 }, r => { assert.ok(r.updates.length); assert.equal(r.monitoringContinues, false); }],
  ['stream candles', { symbol: 'COINBASE:ETHUSD', timeframe: '1h', count: 3, seconds: 1, 'max-updates': 1 }, r => { assert.ok(r.updates[0].data.lastBar.close > 0); assert.equal(r.monitoringContinues, false); }],
  ['stream indicator', { symbol: 'COINBASE:ETHUSD', indicator: 'Volume@tv-basicstudies-241', count: 3, seconds: 1, 'max-updates': 1 }, r => { assert.ok(r.updates[0].data.lastBar.close > 0); assert.ok(r.updates[0].data.values); assert.equal(r.monitoringContinues, false); }],
  ['chart', { symbol: 'COINBASE:BTCUSD', count: 5 }, r => assert.equal(r.data.schemaVersion, 1)],
];
for (const [command, args, check] of checks) {
  const started = performance.now();
  try { const result = await service.execute(command, { ...args, auth: 'anonymous', 'timeout-ms': 12000 }); check(result);
    report.results.push({ command, status: 'passed', elapsedMs: Math.round(performance.now() - started) }); }
  catch (error) { report.results.push({ command, status: 'failed', code: error.code ?? 'CHECK_FAILED' }); }
}
report.peakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024 * 10) / 10;
report.limitations = ['Development-host run; not an Orin memory measurement.', 'No account login, paid entitlements, UI parity or sustained streaming verified.'];
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.results.some(row => row.status !== 'passed') ? 1 : 0;
