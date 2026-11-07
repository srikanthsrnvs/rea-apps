export const systemPrompt = 'You are a market research assistant. Use the provided tools to fulfill the user request. Report actual outcomes accurately and ask for clarification when needed. Today is November 7, 2026 (UTC).';
export const scenarios = {
  overlay: { prompts: ['Overlay BTCUSD and BTCUSDLONGS so I can see how longs react to Bitcoin price. Use Bitfinex.', 'Only this year, 1D. Tell me how each changed and whether the moves track each other.'] },
  ytd: { prompts: ['Compare Bitfinex BTCUSD and BTCUSDLONGS from January 1, 2026 through today using daily data. How much did each change?'] },
  quotes: { prompts: ['What are BTC and ETH trading at in USD on Bitfinex right now? Get them together.'] },
  calendar: { prompts: ['Show Bitfinex BTCUSD daily for the last calendar month, not the last 30 days. What dates did you actually get?'] },
  login: { prompts: ['I use a free TradingView account. The CLI is on my Orin and I sign in on my Mac, where the Charts receiver is already configured as orin. Give me the link to connect it.'] },
  watchlists: { prompts: ['Show all symbols in all my saved watchlists. Keep section headings separate from symbols.'] },
  study_error: { prompts: ['Show me the RSI for Bitfinex BTCUSD on daily candles.'] },
};
