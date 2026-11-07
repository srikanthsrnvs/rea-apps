# Deferred TradingView capabilities

Requested November 7, 2026: keep the following outside the current implementation.

- [ ] Alert creation, editing, deletion and background delivery.
- [ ] Bar Replay and synchronized historical playback.
- [ ] Broker/paper account integration and order execution.
- [ ] Arbitrary Pine source compilation, including custom strategies and optimization.

Other gaps remain: exact TradingView web-app parity, volume footprint/order-flow
data, TPO, volume profile, arbitrary formula series and advanced research
statistics. A local SMA/EMA/RSI calculation in the viewer is not Pine execution.

The current work is a native headless data service plus a separate client-side
interactive editor. Its view is a local REA chart, not a saved TradingView account
layout. Add capabilities only with executable tests and honest provider coverage.
