# Binance Microstructure Service

Node.js sidecar for real Binance Futures public market-data streams. It has no demo branch and produces no analysis until price, depth, trade flow, and open-interest freshness gates are satisfied.

## Streams

- `aggTrade`: signed aggressive-flow delta and bounded CVD buckets
- `depth20@100ms`: top-10 order-book imbalance with update-id health
- `forceOrder`: public liquidation-flow notional and price proximity
- REST `openInterest`: time-aligned OI samples polled every 500 ms through an `undici` keep-alive pool

The service prints newline-delimited JSON analysis to stdout. It does not place orders and does not claim to see or jump a CEX matching queue. `aggTrade` is a post-match event.

## Run

```bash
npm install --no-audit --no-fund
SYMBOL=BTCUSDT npm start
```

Allowed symbols are `BTCUSDT` and `ETHUSDT`. Set `BINANCE_FUTURES_REST_URL` and `BINANCE_FUTURES_WS_URL` only when routing through an approved endpoint. No API key is required for these public feeds.

## Analysis contract

- `OBI` is continuous, depth-weighted by relative distance to mid, and uses the first ten bid and ask levels.
- `LACVD` is bucketed by second and normalizes aggressive delta by current top-five displayed depth.
- `VPIN` uses volume-synchronized buckets and remains unavailable until a one-minute warmup is complete.
- Liquidation pressure uses side-specific notional, quantity-weighted center price, proximity, and a rolling rate baseline. A fixed `50,000 USDT` threshold is not used.
- OI divergence uses `dOI/dt` against price pressure over aligned samples, not a three-second point estimate. The 500 ms polling rate must remain within the account’s exchange request budget.
- Implied liquidation clusters are inferred OI-build price bins, not observable exchange liquidation prices.
- The score is a directional bias, not a calibrated probability and not an order instruction.
- Missing or stale data returns `DATA_INCOMPLETE`; no fallback values are generated.

## Offline replay

The `replayEvents(events, options)` helper in `src/replay.js` evaluates ordered historical events with the same analysis path used by the live collector. It reports settled and pending predictions, directional accuracy, and signed forward return in basis points. This is deterministic evaluation tooling only; it is not a runtime fallback and does not establish profitability.
