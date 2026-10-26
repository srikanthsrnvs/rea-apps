const text = (description, extra = {}) => ({ type: 'string', minLength: 1, maxLength: 256, description, ...extra });
const integer = (description, minimum, maximum, defaultValue) => ({ type: 'integer', description, minimum, maximum,
  ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const flag = description => ({ type: 'boolean', description });
const list = (description, maxItems = 30) => ({ type: 'array', description, items: text('Value'), minItems: 1, maxItems, uniqueItems: true });
const object = description => ({ type: 'object', description, maxProperties: 50, additionalProperties: true });
const symbol = text('Exchange-qualified symbol, for example COINBASE:BTCUSD.');
const auth = { type: 'string', enum: ['auto', 'anonymous', 'required'], default: 'auto',
  description: 'auto uses a saved session if present; anonymous never reads account credentials; required needs a saved session.' };
const network = { auth, 'timeout-ms': integer('Whole-operation deadline in milliseconds.', 1000, 60000, 15000) };
const page = { offset: integer('Zero-based offset.', 0, 100000, 0), limit: integer('Maximum results in this page.', 1, 100, 20) };
const chart = {
  symbol, timeframe: text('TradingView resolution or alias: 1, 60, D, W, M, 1m, 1h, 1d; uppercase M means month.', { default: 'D', maxLength: 12 }),
  count: integer('Maximum returned bars; range queries use this as their history cap.', 1, 5000, 200),
  session: { type: 'string', enum: ['regular', 'extended'], default: 'regular' },
  adjustment: { type: 'string', enum: ['splits', 'dividends', 'none'], default: 'splits' },
  timezone: text('Exchange timezone or an IANA timezone.', { default: 'exchange', maxLength: 64 }),
  currency: text('Optional currency conversion code.', { pattern: '^[A-Z]{3,8}$', maxLength: 8 }),
  'chart-type': { type: 'string', enum: ['HeikinAshi', 'Renko', 'LineBreak', 'Kagi', 'PointAndFigure', 'Range'] },
  'chart-inputs': object('Provider-specific inputs for synthetic chart types.'),
  'back-adjustment': flag('Back-adjust continuous futures.'),
};
const studyQuery = { ...chart, indicator: text('Study ID such as STD;RSI, PUB;..., USER;..., or Volume@tv-basicstudies-241.'),
  version: text('Pin a script version; defaults to last.', { default: 'last' }), inputs: object('Indicator input values keyed by input ID or name.') };
const study = { ...studyQuery,
  plots: list('Optional plot keys to return.', 50), 'include-graphics': flag('Include bounded study drawings; coordinates retain TradingView semantics.') };
const stream = { seconds: integer('Sample duration after startup; this command does not create a background monitor.', 1, 30, 5),
  'max-updates': integer('Maximum captured updates, including the initial snapshot.', 1, 50, 10) };
const define = (command, description, properties = {}, required = [], effect = 'read', online = false) => ({
  name: `charts_${command.replaceAll(' ', '_')}`, command, description, effect, online,
  inputSchema: { type: 'object', properties: { ...(online ? network : {}), ...properties }, required, additionalProperties: false },
});

export const toolDefinitions = [
  define('state', 'Inspect local provider capabilities and session state. This does not validate the saved session with TradingView.'),
  define('providers', 'List the data providers and their supported operations.'),
  define('login', 'Create a native TradingView approval link for the user to open on another device. Complete with the official app callback link. No host browser, cookie export or background worker.', {
    replace: flag('Replace the saved account only after independent validation.'),
    username: text('Optional expected TradingView username; a different validated account is rejected.'),
    'timeout-ms': integer('Bootstrap deadline.', 1000, 60000, 15000),
  }, [], 'auth'),
  define('auth complete', 'Exchange the official native-app callback once, then independently validate the session. Omit the callback to retry validation of an already acquired candidate. Native-app extra 2FA is reported as unsupported rather than launching a browser.', {
    'login-id': text('Login ID returned by login.', { format: 'uuid' }),
    'callback-url': text('Official tradingview://browser-auth/ app link; prefer callback-file to keep it out of process arguments.', { maxLength: 16384 }),
    'callback-file': text('Owner-only local file containing the official callback link.', { maxLength: 4096 }),
    'timeout-ms': integer('Exchange and validation deadline.', 1000, 60000, 15000),
  }, ['login-id'], 'auth'),
  define('auth cancel', 'Discard the pending authorization and candidate credentials while preserving the saved account.', {}, [], 'local'),
  define('auth status', 'Inspect saved account metadata locally without exposing or validating cookies.'),
  define('auth validate', 'Validate the saved session with TradingView and return account identity only.', {}, [], 'read', true),
  define('logout', 'Remove local Charts authorization while leaving other TradingView sessions unchanged.', {}, [], 'local'),
  define('symbols search', 'Search markets. Search is a bounded provider page; use nextOffset for the next page.', {
    query: text('Search text or EXCHANGE:SYMBOL.'), type: text('Optional market type such as crypto, stock, forex or futures.'),
    exchange: text('Optional exchange filter.'), country: text('Optional ISO country code.', { maxLength: 2 }),
    sector: text('Optional sector filter.'), ...page,
  }, ['query'], 'read', true),
  define('symbol', 'Resolve symbol metadata, sessions, timezone, price scale and supported resolutions.', { symbol }, ['symbol'], 'read', true),
  define('quotes', 'Fetch a bounded quote snapshot. Missing values stay null; feed mode and price timestamps describe availability.', {
    symbols: list('Exchange-qualified symbols.', 20), fields: list('Optional upstream quote fields; metadata needed for normalized prices is always requested.', 50),
  }, ['symbols'], 'read', true),
  define('candles', 'Read bounded OHLCV history with actual coverage. Daily times use venue sessions; unfinished bars and synthetic bars are labelled.', {
    ...chart, from: text('Oldest requested time: UTC ISO timestamp with timezone or Unix seconds.', { maxLength: 40 }),
    to: text('Newest requested time: UTC ISO timestamp with timezone or Unix seconds.', { maxLength: 40 }),
  }, ['symbol'], 'read', true),
  define('technicals', 'Read TradingView scanner ratings across eight timeframes. Scores retain the scanner scale [-1,1]; missing values are not neutral scores.', { symbol }, ['symbol'], 'read', true),
  define('indicators search', 'Search built-in and community studies/strategies. Returns metadata, not Pine source or compiled scripts.', {
    query: text('Search text.'), ...page,
  }, ['query'], 'read', true),
  define('indicator', 'Read a Pine indicator definition and its editable input/plot metadata without returning compiled code.', {
    indicator: text('Pine script ID.'), version: text('Script version.', { default: 'last' }),
  }, ['indicator'], 'read', true),
  define('indicator values', 'Run an accessible study and align plot rows to candle timestamps. Pine studies need an account; some built-in studies work anonymously.', study, ['symbol', 'indicator'], 'read', true),
  define('strategy report', 'Read an accessible Pine strategy report with a bounded page of trade records. This places no orders and is not Deep Backtesting.', {
    ...studyQuery, ...page,
  }, ['symbol', 'indicator'], 'read', true),
  define('indicators saved', 'Read a bounded page of account-saved private scripts. Requires a saved session.', page, [], 'read', true),
  define('watchlists', 'Read account watchlists without modifying them. Section markers are separate from market symbols.', {
    ...page, 'symbol-limit': integer('Maximum entries returned per watchlist.', 1, 200, 50),
  }, [], 'read', true),
  define('screener fields', 'List curated common scanner fields. Provider-defined fields remain accepted; this is not the complete upstream field catalog.'),
  define('screener', 'Run one bounded scanner page with explicit columns, filters and ranking. A snapshot is not a real-time subscription.', {
    market: text('Scanner universe, for example crypto, america, forex or global.', { default: 'crypto', pattern: '^[a-z][a-z0-9_-]*$', maxLength: 40 }),
    columns: list('Scanner columns, optionally with timeframe suffixes such as RSI|60.', 50),
    symbols: list('Optional exact market symbols.', 20),
    filters: { type: 'array', maxItems: 20, items: { type: 'object', required: ['left', 'operation'], additionalProperties: false,
      properties: { left: text('Field name.'), operation: text('TradingView filter operator.'), right: {} } } },
    'sort-by': text('Optional scanner field to sort by.'), 'sort-order': { type: 'string', enum: ['asc', 'desc'], default: 'desc' }, ...page,
  }, ['columns'], 'read', true),
  define('hotlist', 'Read scanner-ranked gainers, losers or volume leaders. Crypto filters do not inherit the SDK default stock filter; rankings may differ from the website widget.', {
    kind: { type: 'string', enum: ['gainers', 'losers', 'mostActive', 'volumeGainers'] },
    market: text('Scanner universe.', { default: 'crypto', pattern: '^[a-z][a-z0-9_-]*$', maxLength: 40 }), ...page,
  }, ['kind'], 'read', true),
  define('drawings', 'Read bounded saved-layout drawings. Private layouts require the saved account; this does not change the chart.', {
    'layout-id': text('Chart layout ID from tradingview.com/chart/ID/.', { pattern: '^[A-Za-z0-9_-]{1,64}$', maxLength: 64 }),
    symbol, 'chart-id': text('Chart ID within the layout.', { default: '_shared', maxLength: 64 }), ...page,
  }, ['layout-id'], 'read', true),
  define('chart', 'Build a portable candlestick/volume chart dataset from the same normalized bars. No browser is started and no TradingView layout is modified.', chart, ['symbol'], 'read', true),
  define('stream quotes', 'Collect a finite sample of quote updates, then close the subscription. Reports disconnects and never claims to keep monitoring after completion.', {
    symbols: list('Exchange-qualified symbols.', 10), ...stream,
  }, ['symbols'], 'read', true),
  define('stream candles', 'Collect finite last-bar updates, not repeated full histories. The subscription closes after the sample.', { ...chart,
    count: integer('History window retained by the provider during sampling.', 1, 200, 20), ...stream }, ['symbol'], 'read', true),
  define('stream indicator', 'Collect finite latest-bar plot updates; Pine studies need account access. History and graphics are not retained in each event.', { ...studyQuery, plots: study.plots,
    count: integer('History window retained during sampling.', 1, 200, 20), ...stream }, ['symbol', 'indicator'], 'read', true),
];

export const commonScannerFields = [
  ['name', 'Symbol display name'], ['close', 'Latest scanner price'], ['volume', 'Volume in provider-defined units'],
  ['change', 'Percentage price change'], ['update_mode', 'Reported streaming or delayed mode'],
  ['Recommend.All', 'Combined technical rating, [-1,1]'], ['Recommend.MA', 'Moving-average rating, [-1,1]'],
  ['Recommend.Other', 'Oscillator rating, [-1,1]'], ['RSI', 'Relative Strength Index'],
  ['MACD.macd', 'MACD value'], ['MACD.signal', 'MACD signal'], ['market_cap_basic', 'Market capitalization where available'],
].map(([name, description]) => ({ name, description }));
