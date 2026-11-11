export {systemPrompt} from './scenarios.mjs';
import {scenarios as complex} from './complex-scenarios.mjs';
export const scenarios={
 multi_timeframe:complex.multi_timeframe,
 screener_pages:complex.screener_pages,
 editor:{prompts:[
  'Create and display an interactive chart of BITFINEX:BTCUSD and BITFINEX:BTCUSDLONGS for this year, daily, both as percentage changes. Return the local browser link. This is a temporary view, not a TradingView account layout.',
  'Edit that same chart: title it Bitcoin versus margin longs, make the BTC line blue and the longs line orange, add a 20-period SMA for BTCUSD on the price pane and a 14-period RSI for BTCUSD in a separate pane. Keep the existing series. Do it through the chart tools, not instructions for me.',
  'Now keep that same chart but use just BTCUSD as ordinary candles for the last calendar month on one-hour bars, raw prices with a logarithmic scale. Keep RSI in its separate pane, remove SMA and the longs series. Return the same viewer link.'
 ]},
};
