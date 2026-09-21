# LiqHunter Core Engine

Private Rust core and Node.js market-data sidecar for Binance Futures microstructure analysis.

## Current scope

This first commit contains deterministic, testable risk primitives:

- Decimal arithmetic for liquidation-price and order-book calculations
- Long and short position inputs with caller-supplied maintenance margin
- Top-10 order-book imbalance
- 200 ms default data-freshness guard
- Configurable liquidation proximity and OBI thresholds
- Direction-aware execution-slippage validation
- HMAC-SHA256 Binance order-request builder with an explicit live-trading gate
- Node.js collector for `aggTrade`, `depth20@100ms`, `forceOrder`, and Open Interest
- Depth-weighted OBI, liquidity-adjusted CVD, VPIN, liquidation-flow, and dOI/dt divergence analysis
- Volatility-regime-dependent nonlinear evidence fusion
- Unit tests for the trigger and kill conditions

The module does not pretend that public exchange feeds expose a matching-engine mempool. `aggTrade` is a post-match event, so this project does not implement front-running or claim priority over another participant. Execution adapters will be a separate, explicitly guarded layer.

The execution adapter is now present as `src/engine/execution.rs`, but it is disabled unless `LIVE_TRADING_ENABLED=true` is explicitly set. It performs no automatic retries, so a timeout cannot silently duplicate an order. It also does not log secrets. Exchange symbol filters, account state, clock synchronization, daily-loss accounting, and a hard-kill supervisor must be completed before any live enablement.

## Configuration

Non-secret deployment parameters are documented in `.env.example`. API keys must never be committed. Use a VPS secret store or process environment with withdrawal disabled and exchange-side IP restrictions.

The requested baseline is represented without credentials:

- Binance Futures REST: `https://fapi.binance.com`
- Binance Futures WebSocket: `wss://fstream.binance.com/ws`
- Symbols: `BTCUSDT`, `ETHUSDT`
- Runtime target: Rust with Tokio for the service layer
- Maximum slippage: 15 bps
- Data freshness limit: 200 ms

## Verification

GitHub Actions runs formatting, tests, and Clippy on every push and pull request.

The repository is not connected to a live account and contains no API keys.

`src/main.rs` wires the analysis and execution components for startup verification only. It intentionally does not start a live order loop.

## Node microstructure sidecar

The real public-feed collector lives in `services/microstructure-node/`. It has no mock or demo branch. Until price, depth, trade flow, and Open Interest freshness gates are satisfied, it returns `DATA_INCOMPLETE` and does not invent a signal.

Run it with Node.js 22 or newer:

```bash
cd services/microstructure-node
npm install --no-audit --no-fund
SYMBOL=BTCUSDT npm start
```

The service prints newline-delimited JSON. Its score is a directional bias, not a calibrated probability or an order instruction. It does not claim access to a centralized exchange matching queue.
