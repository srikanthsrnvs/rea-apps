import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharts } from '../src/service.mjs';
import { timeframe, timestamp } from '../src/validation.mjs';
import { publicError, boundedResult } from '../src/errors.mjs';
import { parse, dispatch } from '../src/cli.mjs';

const store = { load: async () => null };
const candle = time => ({ time, open: 10, high: 12, low: 9, close: 11, volume: null });
const sdkWith = sdk => createCharts({ sdk, store });

test('invalid arguments are rejected before state and network access', async () => {
  let reads = 0;
  const service = createCharts({ sdk: {}, store: { load() { reads++; throw new Error(); } } });
  for (const [name, input] of [
    ['candles', { symbol: 'BTCUSD' }], ['candles', { symbol: 'X:Y', count: 5001 }],
    ['candles', { symbol: 'X:Y', from: '2026-10-20T00:00:00Z', to: '2026-10-19T00:00:00Z' }],
    ['quotes', { symbols: ['X:Y', 'X:Y'] }], ['screener', { columns: ['close'], market: '../account' }],
    ['watchlists', { auth: 'anonymous' }], ['login', { 'cdp-url': 'http://127.0.0.1:9222' }],
    ['quotes', { symbols: ['X:Y'], password: 'do-not-output' }],
  ]) await assert.rejects(service.execute(name, input));
  assert.equal(reads, 0);
});

test('timeframes preserve minute/month distinction and timestamps reject milliseconds', () => {
  assert.equal(timeframe('1m'), '1'); assert.equal(timeframe('1h'), '60');
  assert.equal(timeframe('1mo'), 'M'); assert.equal(timeframe('M'), 'M');
  assert.equal(timestamp('2026-10-26T00:00:00Z'), 1792972800);
  assert.throws(() => timestamp('1792972800000'));
  assert.throws(() => timeframe('1hour'));
});

test('candle requests cap history and honestly report a short response', async () => {
  let request;
  const service = sdkWith({ getCandles: async value => { request = value; return [candle(100)]; } });
  const result = await service.execute('candles', { symbol: 'COINBASE:BTCUSD', timeframe: '1h', count: 3 });
  assert.equal(request.timeframe, '60'); assert.equal(request.maxCount, 3);
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.complete, false);
  assert.equal(result.data[0].volume, null); assert.deepEqual(result.warnings, ['PARTIAL_HISTORY']);
  const range = await service.execute('candles', { symbol: 'COINBASE:BTCUSD', count: 3, from: '1', to: '100' });
  assert.equal(range.coverage.requestedBars, null); assert.equal(range.coverage.complete, null);
  const chart = await service.execute('chart', { symbol: 'COINBASE:BTCUSD', count: 3 });
  assert.equal(chart.status, 'partial'); assert.equal(chart.data.coverage.complete, false);
});

test('malformed candles fail rather than presenting invalid charts', async () => {
  for (const rows of [[{ ...candle(100), high: 8 }], [candle(100), candle(100)]]) {
    await assert.rejects(sdkWith({ getCandles: async () => rows }).execute('candles', { symbol: 'X:Y', count: 2 }), { code: 'PROTOCOL_ERROR' });
  }
});

test('technical ratings keep unavailable values null on the original scanner scale', async () => {
  const result = await sdkWith({ getScreener: async query => {
    assert.equal(query.columns.length, 25); assert.equal(query.symbols[0], 'X:Y');
    return { rows: [{ values: { 'Recommend.All': null, 'Recommend.MA': 0.5, 'Recommend.Other': 0, update_mode: 'delayed_streaming_900' } }] };
  } }).execute('technicals', { symbol: 'X:Y' });
  const daily = result.data.find(row => row.timeframe === '1D');
  assert.equal(daily.summary, null); assert.equal(daily.movingAverages, 0.5); assert.equal(daily.oscillators, 0);
  assert.equal(result.feed.delaySeconds, 900); assert.equal(result.scale.maximum, 1);
});

test('indicator values align by timestamp, exclude warm-up rows and omit compiled scripts', async () => {
  const result = await sdkWith({ getIndicatorData: async () => ({
    indicator: { id: 'STD;RSI', script: 'private-compiled-code', inputs: {}, plots: { plot_0: 'RSI' } },
    candles: [candle(100), candle(200)], values: [{ $time: 50, RSI: 1 }, { $time: 100, RSI: null }, { $time: 200, RSI: 42 }],
  }) }).execute('indicator values', { symbol: 'X:Y', indicator: 'STD;RSI', count: 2 });
  assert.equal(result.warmupRowsExcluded, 1);
  assert.deepEqual(result.values, [{ time: 100, plots: { RSI: null } }, { time: 200, plots: { RSI: 42 } }]);
  assert.doesNotMatch(JSON.stringify(result), /private-compiled-code/);
});

test('scanner pages forward exact bounds and crypto rankings override the stock default', async () => {
  const service = sdkWith({
    getScreener: async query => {
      assert.deepEqual(query.range, [5, 7]); assert.deepEqual(query.filter, [{ left: 'RSI', operation: 'less', right: 40 }]);
      return { totalCount: 10, rows: [{ symbol: 'X:Y', values: { close: null } }] };
    },
    getHotlist: async query => { assert.deepEqual(query.filter, []); assert.equal(query.market, 'crypto'); return { totalCount: 0, rows: [] }; },
  });
  const scan = await service.execute('screener', { columns: ['close'], offset: 5, limit: 2, filters: [{ left: 'RSI', operation: 'less', right: 40 }] });
  assert.equal(scan.pagination.nextOffset, 6); assert.equal(scan.data[0].values.close, null);
  assert.equal((await service.execute('hotlist', { kind: 'gainers' })).pagination.nextOffset, null);
});

test('missing batch quotes are explicit and do not become fabricated zeros', async () => {
  const result = await sdkWith({ getQuotes: async () => ({ 'X:Y': { lp: 0, lp_time: 100, update_mode: 'streaming' } }) })
    .execute('quotes', { symbols: ['X:Y', 'X:Z'] });
  assert.equal(result.status, 'partial'); assert.deepEqual(result.missing, ['X:Z']);
  assert.equal(result.data[0].last, 0); assert.equal(result.data[1].last, null); assert.equal(result.data[1].available, false);
});

test('one provider request at a time bounds MCP concurrency', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const service = sdkWith({ getCandles: async () => { await waiting; return [candle(100)]; } });
  const first = service.execute('candles', { symbol: 'X:Y', count: 1 });
  await assert.rejects(service.execute('quotes', { symbols: ['X:Y'] }), { code: 'PROVIDER_BUSY' });
  release(); await first;
});

test('public errors and output omit upstream secrets and enforce output size', () => {
  const error = publicError(Object.assign(new Error('cookie=secret-value'), { code: 'HTTP_ERROR', details: { sessionid: 'secret-value' } }));
  assert.equal(error.code, 'HTTP_ERROR'); assert.doesNotMatch(JSON.stringify(error), /secret-value/);
  assert.deepEqual(boundedResult({ sessionid: 'secret', value: NaN, nested: { authToken: 'secret', ok: 1 } }), { value: null, nested: { ok: 1 } });
  assert.throws(() => boundedResult({ large: 'x'.repeat(2100000) }), { code: 'OUTPUT_LIMIT' });
  assert.deepEqual(boundedResult({ credentials: { session: 'secret' }, access_token: 'secret', keySource: 'secret', callbackUrl: 'secret', ok: true }), { ok: true });
});

test('provider errors after deadline expiry retain timeout semantics', async () => {
  const controller = new AbortController();
  const service = sdkWith({ getQuotes: async () => {
    controller.abort(new DOMException('deadline', 'TimeoutError'));
    throw Object.assign(new Error('provider body'), { code: 'ABORTED' });
  } });
  await assert.rejects(service.execute('quotes', { symbols: ['X:Y'] }, { signal: controller.signal }), { name: 'TimeoutError' });
});

test('scanner pages stay bounded even if the provider ignores the requested limit', async () => {
  const result = await sdkWith({ getScreener: async () => ({ totalCount: 10, rows: Array.from({ length: 5 }, (_, i) => ({ symbol: `X:${i}` })) }) })
    .execute('screener', { columns: ['close'], limit: 2, offset: 3 });
  assert.equal(result.data.length, 2); assert.equal(result.pagination.nextOffset, 5);
  assert.ok(result.warnings.includes('PROVIDER_PAGE_TRUNCATED'));
});

test('CLI schemas are strict, typed and help never executes a tool', async () => {
  assert.equal(parse(['candles', '--symbol', 'X:Y', '--count', '20']).args.count, 20);
  assert.deepEqual(parse(['quotes', '--symbols', '["X:Y"]']).args.symbols, ['X:Y']);
  for (const argv of [['candles', '--count', '2', '--count', '3'], ['login', '--cdp-url', 'secret'], ['quotes', '--password', 'secret']]) assert.throws(() => parse(argv));
  const result = await dispatch(['quotes', '--symbols', '["X:Y"]', '--help'], { service: { execute() { throw new Error('must not execute'); } } });
  assert.ok(result.tools.some(tool => tool.name === 'charts_candles'));
});
