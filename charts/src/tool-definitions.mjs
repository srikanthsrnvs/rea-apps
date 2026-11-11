import { viewChangeSchema, viewProperties } from './view-model.mjs';
const text = (description, extra = {}) => ({ type: 'string', minLength: 1, maxLength: 256, description, ...extra });
const integer = (description, minimum, maximum, defaultValue) => ({ type: 'integer', description, minimum, maximum,
  ...(defaultValue === undefined ? {} : { default: defaultValue }) });
const flag = description => ({ type: 'boolean', description });
const list = (description, maxItems = 30) => ({ type: 'array', description, items: text('Value'), minItems: 1, maxItems, uniqueItems: true });
const object = description => ({ type: 'object', description, maxProperties: 50, additionalProperties: true });
const period = {type:'string',enum:['year_to_date','last_calendar_month','last_30_days','last_90_days','last_365_days'],description:'Exact UTC date window. Use last_calendar_month for the prior complete month, or year_to_date for this year. Do not combine with from/to.'};
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
  period,
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
  define('login', 'Validate an existing session or begin free-account TradingView login. Send clientUrl to the configured Mac: our Charts Login receiver opens TradingView\'s official website in the user\'s browser and returns approval over SSH. No TradingView desktop app is required. No browser runs on the host. approvalUrl is the manual alternative.', {
    replace: flag('Replace the saved account only after independent validation.'),
    username: text('Optional expected TradingView username; a different validated account is rejected.'),
    'client-profile': text('Trusted profile configured in the Mac receiver; clientUrl opens sign-in and returns the callback automatically.', { default: 'orin', pattern: '^[a-zA-Z0-9_-]{1,64}$', maxLength: 64 }),
    'timeout-ms': integer('Bootstrap deadline.', 1000, 60000, 15000),
  }, [], 'auth'),
  define('auth complete', 'Exchange the official native-app callback once, then independently validate the session. Omit the callback to retry validation of an already acquired candidate. Native-app extra 2FA is reported as unsupported rather than launching a browser.', {
    'login-id': text('Login ID returned by login.', { format: 'uuid' }),
    'callback-url': text('Official tradingview://browser-auth/ app link; prefer callback-file to keep it out of process arguments.', { maxLength: 16384 }),
    'callback-file': text('Owner-only local file containing the official callback link.', { maxLength: 4096 }),
    'callback-stdin': flag('CLI only: read the callback privately from standard input; do not combine with callback-url or callback-file.'),
    'timeout-ms': integer('Exchange and validation deadline.', 1000, 60000, 15000),
  }, ['login-id'], 'auth'),
  define('auth poll', 'Inspect one specific login after the user approves it. Never returns callback credentials; no background polling process.', {
    'login-id': text('Login ID returned by login.', { format: 'uuid' }),
  }, ['login-id']),
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
  define('quotes', 'Get multiple quotes together in one call. asOf is the price observation time; fetchedAt is only request time. Read measurement/unit: BTCUSDLONGS is a BTC quantity, not a dollar price.', {
    symbols: list('Exchange-qualified symbols.', 20), fields: list('Optional upstream quote fields; metadata needed for normalized prices is always requested.', 50),
  }, ['symbols'], 'read', true),
  define('candles', 'Get one series of OHLCV bars with ISO dates and a change summary. For last calendar month use period=last_calendar_month; count alone is NOT a date range. For an overlay or comparison of symbols use compare.', {
    ...chart, from: text('Oldest requested time: UTC ISO timestamp with timezone or Unix seconds.', { maxLength: 40 }),
    to: text('Newest requested time: UTC ISO timestamp with timezone or Unix seconds.', { maxLength: 40 }),
  }, ['symbol'], 'read', true),
  define('compare', 'Compare 2–6 symbols in one call: aligned dates, first/last values, percentage changes, units and return correlation. Answer from these summaries; near-zero correlation means weak linear tracking, even if its sign is negative. Position quantities do not reveal leverage ratios or trader motives. Defaults to daily year-to-date. For an overlay set include-data=true: complete plot data goes to the renderer, but the tool does not render an image.', {
    symbols:{...list('Exchange-qualified series. BTCUSDLONGS is BITFINEX:BTCUSDLONGS and measures BTC positions.',6),minItems:2},
    timeframe:chart.timeframe,count:integer('Maximum bars per symbol. Truncation remains explicit.',2,5000,1000),period,
    from:text('Optional UTC ISO start or Unix seconds; omit period when supplying dates.',{maxLength:40}),
    to:text('Optional UTC ISO end or Unix seconds; omit period when supplying dates.',{maxLength:40}),
    'include-data':flag('Include portable overlay rows for plotting. Omit for a compact comparison summary.'),
  },['symbols'],'read',true),
  define('technicals', 'Get current RSI (0–100) and technical ratings for eight timeframes in one call. For multiple symbols or RSI/MACD/EMA together use snapshot. Neither requires running a Pine study. Ratings retain [-1,1]; missing values stay null.', { symbol }, ['symbol'], 'read', true),
  define('snapshot', 'Get current indicator values for many symbols and timeframes in ONE call. Use for RSI, MACD line/signal and moving averages instead of repeated symbol lookups or Pine requests. Snapshot only; not historical indicator plots. Missing values stay null.',{
    symbols:list('Exact exchange-qualified symbols.',20),
    metrics:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:{type:'string',enum:['RSI','MACD','EMA20','EMA50','EMA200','SMA20','SMA50','SMA200','close','volume']}},
    timeframes:{type:'array',minItems:1,maxItems:6,uniqueItems:true,items:{type:'string',enum:['1m','5m','15m','1h','4h','D','W','M']},default:['D']},
    market:text('Scanner universe.',{default:'global'}),
  },['symbols','metrics'],'read',true),
  define('screen','Screen stocks using common numeric filters without guessing provider field names. Includes price, market cap, RSI and volume. Use nextRequest for the next page with identical filters and sort. For arbitrary provider fields retain the raw screener tool.',{
    market:text('Stock universe.',{default:'america'}),
    'min-market-cap':{type:'number',minimum:0},'min-average-volume':{type:'number',minimum:0},'min-volume':{type:'number',minimum:0},
    'rsi-min':{type:'number',minimum:0,maximum:100},'rsi-max':{type:'number',minimum:0,maximum:100},
    'sort-by':{type:'string',enum:['volume','market-cap','rsi','price','average-volume'],default:'volume'},
    'sort-order':{type:'string',enum:['asc','desc'],default:'desc'},...page,
  },[],'read',true),
  define('indicators search', 'Search built-in and community studies/strategies. Returns metadata, not Pine source or compiled scripts.', {
    query: text('Search text.'), ...page,
  }, ['query'], 'read', true),
  define('indicator', 'Read a Pine indicator definition and its editable input/plot metadata without returning compiled code.', {
    indicator: text('Pine script ID.'), version: text('Script version.', { default: 'last' }),
  }, ['indicator'], 'read', true),
  define('indicator values', 'Run a study for historical plot series and align rows to candles. For a current RSI reading or technical ratings use technicals instead. Pine studies need an account; some built-in studies work anonymously.', study, ['symbol', 'indicator'], 'read', true),
  define('strategy report', 'Read an accessible Pine strategy report with a bounded page of trade records. This places no orders and is not Deep Backtesting.', {
    ...studyQuery, ...page,
  }, ['symbol', 'indicator'], 'read', true),
  define('indicators saved', 'Read a bounded page of account-saved private scripts. Requires a saved session.', page, [], 'read', true),
  define('watchlists', 'Read account watchlists; section headings are not symbols. When asked to list all symbols, include every symbol, without ellipsis or samples. complete=false requires following nextRequests first.', {
    ...page, 'symbol-limit': integer('Maximum entries returned per watchlist page.', 1, 200, 200),
    'entry-offset':integer('Zero-based entry offset within each selected watchlist. Follow nextRequests for remaining entries.',0,100000,0),
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
  define('view create', 'Display an interactive editable chart in the user\'s browser. Returns viewerUrl and viewId; send the link to the user. The host starts a temporary native HTTP server, never a browser. For a remote client supply a reachable public-url and host=0.0.0.0. Use view update to edit the same chart.', {
    symbols:list('Exchange-qualified symbols to display.',6),title:viewProperties.title,timeframe:chart.timeframe,
    count:integer('Bars when no date window is set. A date window is automatically sized up to 5000 bars.',2,5000,1000),period,from:text('Optional ISO start or Unix seconds.'),to:text('Optional ISO end or Unix seconds.'),
    normalization:viewProperties.normalization,theme:viewProperties.theme,
    host:{type:'string',enum:['127.0.0.1','0.0.0.0','::1'],default:'127.0.0.1'},port:integer('Listening port; zero chooses a free port.',0,65535,0),
    'public-url':text('Client-reachable HTTP(S) origin mapped to this server port. Never invent a reachable URL.'),
    public:flag('Create a temporary HTTPS link using an installed cloudflared tunnel. Required for clients on another machine unless public-url is supplied.'),
    'duration-seconds':integer('View lifetime; server stops automatically.',60,86400,3600),
    'timeout-ms':integer('Initial chart load deadline.',1000,60000,60000),
  },['symbols'],'local',true),
  define('view state', 'Read an existing view\'s current configuration, stable series IDs, revision and browser connection status. Does not expose raw chart rows or account credentials.', {
    'view-id':text('viewId from view create.',{pattern:'^[a-f0-9]{12,24}$'}),
  },['view-id']),
  define('view update', 'Edit the existing browser chart in one call. For candles set changes.chartType=candlestick; for lines use line. Use removeSeries/removeStudies/removeDrawings with IDs for removals. Other edits: title, timeframe, period, normalization, scale, series colors/panes, studies and drawings. Study symbol defaults to the primary series. Arrays replace membership but preserve omitted fields of existing IDs. The browser updates automatically. This edits our local view, not a TradingView account layout.', {
    'view-id':text('viewId from view create.',{pattern:'^[a-f0-9]{12,24}$'}),changes:viewChangeSchema,revision:integer('Optional expected revision; stale edits are rejected.',1,1000000),
  },['view-id','changes'],'local'),
  define('view close', 'Close a temporary chart server and revoke its link.',{'view-id':text('viewId from view create.',{pattern:'^[a-f0-9]{12,24}$'})},['view-id'],'local'),
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
