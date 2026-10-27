import { toolDefinitions, commonScannerFields } from './tool-definitions.mjs';
import { validateArguments, marketSymbol, chartQuery } from './validation.mjs';
import { ChartsError, boundedResult } from './errors.mjs';
import { createSessionStore } from './session.mjs';
import { candleResult, quote, indicatorMetadata, searchMetadata, studyResult, numberOrNull, feed } from './normalize.mjs';
import { sampleStream } from './streams.mjs';
import { createAuth } from './auth.mjs';
import { boundedFetch } from './http.mjs';

export const provider = {
  id: 'tradingview', implementation: '@mathieuc/tradingview', version: '4.1.0', official: false,
  capabilities: ['symbols', 'quotes', 'candles', 'technicals', 'screening', 'indicators', 'strategy_reports', 'drawings', 'bounded_streams'],
  accountCapabilities: ['pine_studies', 'saved_indicators', 'watchlists', 'private_layouts'],
  login: 'native_callback_handoff', hostBrowser: false, orderExecution: false,
  authenticationVerification: 'orin_callback_and_account_reads_verified', additionalNative2faSupported: false,
};
const accountCommands = new Set(['auth validate', 'indicators saved', 'watchlists']);
const page = (rows, o) => ({ data: rows.slice(o.offset, o.offset + o.limit), pagination: {
  offset: o.offset, limit: o.limit, totalCount: rows.length,
  nextOffset: o.offset + o.limit < rows.length ? o.offset + o.limit : null,
} });
const scannerPage = (result, o) => {
  if (!Array.isArray(result?.rows) || !Number.isSafeInteger(result.totalCount) || result.totalCount < 0) throw new ChartsError('PROTOCOL_ERROR', 'TradingView returned an invalid scanner page.');
  const rows = result.rows.slice(0, o.limit);
  return { data: rows, pagination: {
    offset: o.offset, limit: o.limit, totalCount: result.totalCount,
    nextOffset: o.offset + rows.length < result.totalCount && rows.length ? o.offset + rows.length : null,
  }, warnings: ['SCANNER_SNAPSHOT_NOT_A_SUBSCRIPTION', ...(result.rows.length > o.limit ? ['PROVIDER_PAGE_TRUNCATED'] : [])] };
};

export function createCharts({ sdk: injectedSdk, store = createSessionStore(),
  now = () => new Date().toISOString() } = {}) {
  const sdkLoader = () => injectedSdk ?? import('@mathieuc/tradingview');
  const authClient = createAuth({ store, sdk: sdkLoader });
  async function execute(name, input = {}, { signal: externalSignal } = {}) {
    const definition = toolDefinitions.find(tool => tool.name === name || tool.command === name);
    if (!definition) throw new ChartsError('UNKNOWN_TOOL', 'Unknown Charts tool. Run charts tools.');
    const o = validateArguments(definition, input);
    // Cross-field and market validation precede local state and network access.
    if (o.symbol) marketSymbol(o.symbol);
    if (o.symbols) o.symbols.forEach(marketSymbol);
    const chart = o.timeframe !== undefined ? chartQuery(o) : null;
    if (accountCommands.has(definition.command) && o.auth === 'anonymous') throw new ChartsError('AUTH_REQUIRED', 'This tool requires a saved TradingView account session.');
    const timeout = AbortSignal.timeout(o['timeout-ms'] ?? 15000);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      const result = payload => boundedResult({ status: payload?.coverage?.complete === false ? 'partial' : 'ok', message: 'Operation completed.', provider: 'tradingview', fetchedAt: now(), warnings: [], ...payload });
      const command = definition.command;
      if (command === 'providers') return result({ data: [provider] });
      if (command === 'screener fields') return result({ curated: true, exhaustive: false, data: commonScannerFields,
        timeframeSuffix: 'Append |60, |240, |1W, etc. where supported; availability differs by universe.' });
      if (command === 'logout') return result(await authClient.logout(signal));
      if (command === 'auth cancel') return result(await authClient.cancel(signal));
      if (command === 'state' || command === 'auth status') {
        return result({ data: { ...await authClient.status(signal), ...(command === 'state' ? { providers: [provider] } : {}) } });
      }
      if (command === 'login') {
        return result(await authClient.login(o, signal));
      }
      if (command === 'auth complete') return result(await authClient.complete(o, signal));

      const session = o.auth === 'anonymous' ? null : await store.load();
      if ((o.auth === 'required' || accountCommands.has(command)) && !session) throw new ChartsError('AUTH_REQUIRED', 'This operation requires a validated TradingView account grant. Public tools work anonymously.');
      if (session?.cookieExpiresAt && Date.parse(session.cookieExpiresAt) <= Date.now()) throw new ChartsError('AUTH_ERROR', 'The saved session has expired. Run charts login --replace, or select auth=anonymous for public reads.');
      const credentials = session?.credentials;
      const sdk = await sdkLoader();
      const http = { signal, fetch: boundedFetch, ...(credentials ? { credentials } : {}) };
      const transport = injectedSdk ? undefined : (await import('./transport.mjs')).boundedTransport;
      const socket = { ...http, timeoutMs: o['timeout-ms'], clientOptions: { fetch: boundedFetch, transport, connectTimeoutMs: o['timeout-ms'] } };
      const study = () => ({ ...chart, ...socket, indicator: o.indicator, version: o.version, inputs: o.inputs });

      switch (command) {
        case 'auth validate': {
          const user = await sdk.getUser(credentials, http);
          if (!Number.isSafeInteger(user.id) || user.id <= 0 || !user.username || user.id !== session.account.id) throw new ChartsError('AUTH_ERROR', 'The saved session did not validate as its recorded account.');
          return result({ data: { authenticated: true, validated: true, account: { id: user.id, username: user.username } } });
        }
        case 'symbols search': {
          const rows = await sdk.searchMarkets(o.query, { ...http, offset: o.offset, type: o.type, exchange: o.exchange, country: o.country, sector: o.sector });
          const count = Math.min(rows.length, o.limit);
          return result({ data: rows.slice(0, count), pagination: { offset: o.offset, limit: o.limit,
            nextOffset: rows.length >= o.limit ? o.offset + count : null, totalCount: null } });
        }
        case 'symbol': return result({ data: await sdk.getSymbolInfo({ symbol: o.symbol, ...socket }) });
        case 'quotes': {
          const fields = o.fields ? [...new Set([...o.fields, 'lp', 'lp_time', 'update_mode', 'currency_code', 'type'])] : undefined;
          const data = await sdk.getQuotes({ symbols: o.symbols, fields, ...socket });
          const missing = o.symbols.filter(symbol => !data[symbol]);
          return result({ status: missing.length ? 'partial' : 'ok',
            data: o.symbols.map(symbol => ({ available: Boolean(data[symbol]), ...quote(symbol, data[symbol] ?? {}) })),
            missing, warnings: missing.length ? ['QUOTES_UNAVAILABLE'] : [] });
        }
        case 'candles': case 'chart': {
          const data = candleResult(await sdk.getCandles({ ...chart, ...socket }), chart);
          if (command === 'chart') return result({ status: data.coverage.complete === false ? 'partial' : 'ok', data: { schemaVersion: 1, renderer: 'provider_independent', ...data,
            series: [{ id: 'price', kind: 'candlestick', pane: 0 }, { id: 'volume', kind: 'histogram', pane: 1 }] }, warnings: data.warnings });
          return result({ ...data, status: data.coverage.complete === false ? 'partial' : 'ok' });
        }
        case 'technicals': {
          const periods = ['1', '5', '15', '60', '240', '1D', '1W', '1M'];
          const names = ['Recommend.All', 'Recommend.MA', 'Recommend.Other'];
          const columns = periods.flatMap(period => names.map(field => period === '1D' ? field : `${field}|${period}`));
          // getTechnicalAnalysis() in 4.1.0 coerces upstream nulls to zero. Use
          // this same SDK's scanner primitive so absent ratings stay absent.
          const response = await sdk.getScreener({ market: 'global', symbols: [o.symbol], columns: [...columns, 'update_mode'], range: [0, 1] }, http);
          const values = response.rows[0]?.values;
          if (!values) throw new ChartsError('NO_DATA', 'No technical ratings were returned for this symbol.');
          return result({ symbol: o.symbol, scale: { minimum: -1, maximum: 1, source: 'TradingView scanner' },
            feed: feed(values.update_mode), data: periods.map(period => ({ timeframe: period,
              summary: numberOrNull(values[period === '1D' ? names[0] : `${names[0]}|${period}`]),
              movingAverages: numberOrNull(values[period === '1D' ? names[1] : `${names[1]}|${period}`]),
              oscillators: numberOrNull(values[period === '1D' ? names[2] : `${names[2]}|${period}`]) })) });
        }
        case 'indicators search': return result(page((await sdk.searchIndicators(o.query, http)).map(searchMetadata), o));
        case 'indicator': return result({ data: indicatorMetadata(await sdk.getIndicator(o.indicator, { ...http, version: o.version })) });
        case 'indicator values': return result(studyResult(await sdk.getIndicatorData(study()), chart, o));
        case 'strategy report': {
          const response = await sdk.getIndicatorData(study()), report = response.strategyReport;
          if (!report || !Object.keys(report).length) throw new ChartsError('NOT_A_STRATEGY', 'This script did not return a strategy report. Use an accessible strategy ID from indicators search.');
          return result({ symbol: o.symbol, timeframe: chart.timeframe, indicator: indicatorMetadata(response.indicator),
            coverage: candleResult(response.candles, chart).coverage,
            summary: sdk.summarizeStrategyReport(report), performance: report.performance, currency: report.currency, settings: report.settings,
            trades: page(report.trades ?? [], o), history: Object.fromEntries(Object.entries(report.history ?? {}).map(([key, rows]) => [key, Array.isArray(rows) ? rows.slice(-o.count) : rows])),
            warnings: ['RECORDS_MAY_INCLUDE_OPEN_POSITIONS', 'REPORT_COMPLETENESS_NOT_VERIFIED'] });
        }
        case 'indicators saved': return result(page((await sdk.getPrivateIndicators(credentials, http)).map(searchMetadata), o));
        case 'watchlists': {
          const rows = await sdk.getWatchlists({ ...http, credentials });
          const selected = page(rows, o);
          return result({ ...selected, data: selected.data.map(list => ({ id: list.id, name: list.name,
            entries: list.symbols.slice(0, o['symbol-limit']).map(value => ({ value, kind: !value.startsWith('###') && /^[A-Za-z0-9_./-]+:[A-Za-z0-9_!./%+@=-]+$/u.test(value) ? 'symbol' : 'section' })),
            entryCount: list.symbols.length, entriesTruncated: list.symbols.length > o['symbol-limit'] })) });
        }
        case 'screener': return result(scannerPage(await sdk.getScreener({ market: o.market, columns: o.columns,
          symbols: o.symbols, filter: o.filters, sort: o['sort-by'] ? { sortBy: o['sort-by'], sortOrder: o['sort-order'] } : undefined,
          range: [o.offset, o.offset + o.limit] }, http), o));
        case 'hotlist': return result(scannerPage(await sdk.getHotlist({ market: o.market, kind: o.kind, filter: [], range: [o.offset, o.offset + o.limit] }, http), o));
        case 'drawings': return result(page(await sdk.getDrawings(o['layout-id'], { ...http, userId: session?.account.id, symbol: o.symbol, chartId: o['chart-id'] }), o));
        case 'stream quotes': case 'stream candles': case 'stream indicator': {
          const transform = command === 'stream quotes' ? ((symbol, data) => {
            if (numberOrNull(data.lp) === null) return undefined;
            const { fields: _fields, ...compact } = quote(symbol, data); return compact;
          }) : command === 'stream candles' ? data => {
            const snapshot = candleResult(data, chart);
            return { instrument: snapshot.instrument, timeframe: chart.timeframe, lastBar: snapshot.data.at(-1) };
          } : data => {
            const snapshot = studyResult(data, chart, o);
            return { instrument: snapshot.instrument, timeframe: chart.timeframe, indicator: snapshot.indicator.id,
              lastBar: snapshot.data.at(-1), values: snapshot.values.at(-1) ?? null };
          };
          const start = handlers => command === 'stream quotes' ? sdk.watchQuotes({ symbols: o.symbols, ...socket }, handlers)
            : command === 'stream candles' ? sdk.watchCandles({ ...chart, ...socket }, handlers) : sdk.watchIndicator(study(), handlers);
          const data = await sampleStream(start, { seconds: o.seconds, maxUpdates: o['max-updates'], signal, transform, now });
          return result({ ...data, status: data.warnings.length ? 'partial' : 'ok' });
        }
        default: throw new ChartsError('UNKNOWN_TOOL', 'This Charts operation is not implemented.');
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    }
  }
  let active = false;
  return { async execute(name, args, options) {
    const definition = toolDefinitions.find(tool => tool.name === name || tool.command === name);
    const exclusive = definition && (definition.online || definition.effect !== 'read');
    if (exclusive && active) throw new ChartsError('PROVIDER_BUSY', 'Another Charts request is active. Retry after it completes.');
    if (exclusive) active = true;
    try { return await execute(name, args, options); }
    finally { if (exclusive) active = false; }
  } };
}
