import { ChartsError } from './errors.mjs';

export const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export const instrument = symbol => ({ providerSymbol: symbol, venue: symbol.split(':')[0] });
export function feed(mode) {
  const delay = typeof mode === 'string' ? /^delayed_streaming_(\d+)$/u.exec(mode) : null;
  return { updateMode: typeof mode === 'string' ? mode : null, delaySeconds: delay ? Number(delay[1]) : null };
}
export function quote(symbol, data) {
  return { instrument: { ...instrument(symbol), type: data.type ?? null, currency: data.currency_code ?? null },
    last: numberOrNull(data.lp), priceTime: numberOrNull(data.lp_time), change: numberOrNull(data.ch),
    changePercent: numberOrNull(data.chp), bid: numberOrNull(data.bid), ask: numberOrNull(data.ask),
    volume: numberOrNull(data.volume), description: data.description ?? null, feed: feed(data.update_mode), fields: data };
}
export function bars(candles, query) {
  if (!Array.isArray(candles) || candles.length > query.count) throw new ChartsError('PROTOCOL_ERROR', 'The provider returned an invalid bar count.');
  let previous = -Infinity;
  return candles.map(candle => {
    if (!Number.isSafeInteger(candle.time) || candle.time < previous
      || (!query.chartType && candle.time === previous)
      || !['open', 'high', 'low', 'close'].every(key => numberOrNull(candle[key]) !== null)
      || candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close)
      || candle.high < candle.low) throw new ChartsError('PROTOCOL_ERROR', 'The provider returned malformed or unordered candles.');
    previous = candle.time;
    return { time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close,
      volume: numberOrNull(candle.volume) };
  });
}
export function coverage(data, query) {
  return { requestedBars: query.from === undefined ? query.count : null, maximumBars: query.count,
    returnedBars: data.length, requestedFrom: query.from ?? null, requestedTo: query.to ?? null,
    firstBarTime: data[0]?.time ?? null, lastBarTime: data.at(-1)?.time ?? null,
    complete: query.from === undefined && data.length < query.count ? false : null,
    gapCheck: 'not_performed', lastBarMayBeOpen: true };
}
export function candleResult(candles, query) {
  const data = bars(candles, query), meta = coverage(data, query);
  return { instrument: instrument(query.symbol), timeframe: query.timeframe, timeUnit: 'unix_seconds',
    timeMeaning: 'bar_open_in_venue_session', session: query.session, timezone: query.timezone,
    adjustment: query.adjustment, currency: query.currency ?? null, chartType: query.chartType ?? 'Candles',
    synthetic: Boolean(query.chartType), coverage: meta, data,
    warnings: [...(meta.complete === false ? ['PARTIAL_HISTORY'] : []), ...(query.from === undefined ? [] : ['RANGE_COVERAGE_UNVERIFIED'])] };
}
export const indicatorMetadata = data => ({ id: data.id ?? data.type, version: data.version, description: data.description,
  shortDescription: data.shortDescription, inputs: data.inputs, plots: data.plots, type: data.type });
export const searchMetadata = data => ({ id: data.id, version: data.version, name: data.name, author: data.author,
  type: data.type, access: data.access, image: data.image });

export function studyResult(result, query, options) {
  const candleData = candleResult(result.candles, query);
  const times = new Set(candleData.data.map(row => row.time));
  const rows = result.values ?? [];
  const inWindow = rows.filter(row => times.has(row.$time));
  const selected = options.plots ? new Set(options.plots) : null;
  const values = inWindow.map(row => ({ time: row.$time, plots: Object.fromEntries(Object.entries(row)
    .filter(([key]) => key !== '$time' && (!selected || selected.has(key)))) }));
  const graphics = options['include-graphics'] ? Object.fromEntries(Object.entries(result.graphics ?? {})
    .filter(([key]) => key !== 'raw').map(([key, value]) => [key, Array.isArray(value) ? value.slice(0, 100) : value])) : undefined;
  return { ...candleData, indicator: indicatorMetadata(result.indicator), values,
    warmupRowsExcluded: rows.length - inWindow.length, ...(graphics ? { graphics, graphicsLimitPerType: 100 } : {}) };
}
