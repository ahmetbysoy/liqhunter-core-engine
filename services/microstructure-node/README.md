# Binance Microstructure Service

Node.js sidecar for real Binance Futures public market-data streams. It has no demo branch and produces no analysis until price, depth, trade flow, and open-interest freshness gates are satisfied.

## Streams

- `aggTrade`: signed aggressive-flow delta and bounded CVD buckets
- `depth20@100ms`: top-10 order-book imbalance with update-id health
- `forceOrder`: public liquidation-flow notional and price proximity
- REST `openInterest`: time-aligned OI samples polled every three seconds

The service prints newline-delimited JSON analysis to stdout. It does not place orders and does not claim to see or jump a CEX matching queue. `aggTrade` is a post-match event.

## Run

```bash
npm install --no-audit --no-fund
SYMBOL=BTCUSDT npm start
```

Allowed symbols are `BTCUSDT` and `ETHUSDT`. Set `BINANCE_FUTURES_REST_URL` and `BINANCE_FUTURES_WS_URL` only when routing through an approved endpoint. No API key is required for these public feeds.

## Analysis contract

- `OBI` is continuous and uses the first ten bid and ask levels.
- `CVD` is bucketed by second and normalized by aggressive flow volume.
- Liquidation pressure uses side-specific notional, quantity-weighted center price, proximity, and a rolling rate baseline. A fixed `50,000 USDT` threshold is not used.
- OI divergence is calculated over aligned samples, not against a three-second point estimate.
- The score is a directional bias, not a calibrated probability and not an order instruction.
- Missing or stale data returns `DATA_INCOMPLETE`; no fallback values are generated.
