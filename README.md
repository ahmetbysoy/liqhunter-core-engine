# LiqHunter Core Engine

Private Rust core for Binance Futures market-data processing and liquidation-risk analysis.

## Current scope

This first commit contains deterministic, testable risk primitives:

- Decimal arithmetic for liquidation-price and order-book calculations
- Long and short position inputs with caller-supplied maintenance margin
- Top-10 order-book imbalance
- 200 ms default data-freshness guard
- Configurable liquidation proximity and OBI thresholds
- Direction-aware execution-slippage validation
- Unit tests for the trigger and kill conditions

The module does not pretend that public exchange feeds expose a matching-engine mempool. `aggTrade` is a post-match event, so this project does not implement front-running or claim priority over another participant. Execution adapters will be a separate, explicitly guarded layer.

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
