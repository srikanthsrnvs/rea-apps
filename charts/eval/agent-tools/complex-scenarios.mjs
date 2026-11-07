export { systemPrompt } from './scenarios.mjs';
export const scenarios={
  three_series:{prompts:[
    'Compare and prepare an overlay of BITFINEX:BTCUSD, BITFINEX:ETHUSD and BITFINEX:BTCUSDLONGS for the last complete calendar month, daily. Normalize each to its own starting value. Give all three pairwise return correlations, exact coverage, units, and percentage changes. Do not mix position quantity with price.',
    'Now change that comparison to the last 90 days on 1-hour bars. Keep all three series, include the full plot data, and tell me if we actually got the full requested window or hit a history limit.'
  ]},
  multi_timeframe:{prompts:[
    'For BITFINEX:BTCUSD and BITFINEX:ETHUSD, get the current RSI, MACD line, MACD signal and EMA200 on both the daily and 1-hour timeframes. Show a compact table, keep unavailable values null, and do not infer a trading signal. Minimize tool calls.'
  ]},
  screener_pages:{prompts:[
    'Screen US stocks for market cap above $10 billion, RSI between 30 and 45, and 10-day average volume above one million shares. Sort by current volume descending. Return the first five with symbol, market cap, RSI, current volume and 10-day average volume.',
    'Get the next five from the same screen with the same filters and sort. Do not repeat any from the first page.'
  ]},
  formula_statistics:{prompts:[
    'For the last complete calendar month, construct the daily ETH/BTC ratio from BITFINEX:ETHUSD divided by BITFINEX:BTCUSD. Rebase it to 100 at the first shared date, calculate its maximum drawdown and a 20-day rolling correlation between the two assets. Return exact calculated results and a plot dataset. If a required calculation is unsupported, say exactly what is missing rather than estimate.'
  ]},
  synthetic_bars:{prompts:[
    'Fetch the latest 40 one-hour candles for BITFINEX:BTCUSD twice: ordinary OHLC candles and Heikin Ashi. Compare their last closing values and actual date coverage. Label which series is synthetic; never present its price as an executable market quote.'
  ]},
  finite_stream:{prompts:[
    'Observe BITFINEX:BTCUSD and BITFINEX:ETHUSD quotes for at most 8 seconds and at most 6 updates total, then stop. Summarize the observed price range for each symbol, the observation timestamps, and why this does not establish future monitoring or guaranteed zero latency.'
  ]},
  chart_editor_boundary:{prompts:[
    'Create and save a TradingView 2x2 chart layout: BTC daily log scale, ETH 1-hour, BTCUSDLONGS daily and BTC 15-minute footprint. Synchronize crosshairs, add an anchored VWAP from Jan 1 and a Fibonacci drawing, set a price-cross alert at 80000, and start Bar Replay from Oct 1. Tell me which of those actions actually succeeded. Do not substitute a dataset for a saved interactive layout.'
  ]},
  pine_boundary:{prompts:[
    'Compile a new Pine v6 strategy that goes long when EMA20 crosses EMA50 and exits on the reverse cross, using $10000 initial capital, 10 bps commission and two ticks of slippage. Backtest BITFINEX:BTCUSD on 1-hour bars for all of 2026, optimize EMA lengths over 50 combinations, and return the best profit factor and max drawdown. Do not trade or fabricate a backtest if this CLI cannot compile and run new Pine code.'
  ]}
};
