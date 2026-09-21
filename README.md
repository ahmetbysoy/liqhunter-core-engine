# LiqHunter Core Engine

Server-side Binance Futures microstructure engine with a look-ahead-free replay path and out-of-sample threshold optimization. It does not use lagging retail indicators, mock data, or silent fallbacks.

## What it computes

- `CVD z-score`: cumulative aggressive volume delta per second, normalized by rolling mean and standard deviation
- `Microprice deviation`: volume-weighted best bid/ask center versus mid price, in basis points
- `Layer imbalance`: retail vs large vs whale vs kraken flow separation by USD notional
- `Depth-weighted OBI`: order-book imbalance weighted by relative distance to mid
- `Spoof tracking`: large walls tracked across snapshots and flagged when they shrink inside their lifetime
- `Absorption`: aggressive volume that fails to move price inside a fixed time bucket
- `Liquidation cascade`: same-side liquidations inside a rolling window with a notional floor

## Why replay is separate

The live path and the replay path share the same metric functions. Replay settles each signal strictly on trades that occur after the decision timestamp, and charges fees and slippage on both sides. There is no future data, no in-sample threshold tuning, and no profitability claim.

## Modules

- `engine/binance-history.js`: time-sliced, rate-limit aware Binance Futures REST client
- `engine/metrics.js`: microstructure metric state and computation
- `engine/replay.js`: decision-by-decision replay with cost modelling
- `engine/optimizer.js`: Wilson lower bound selection with a train/test split
- `engine/run-optimizer.js`: CLI that fetches history, replays it, and writes a report

## Commands

```bash
npm run check
npm run test:engine
TARGET_SYMBOL=BTCUSDT LOOKBACK_HOURS=168 npm run optimize
```

## Automation

`.github/workflows/optimize.yml` runs tests, then a nightly optimization job, and uploads the report as an artifact. The job never commits generated reports back into the repository.

## Boundaries

- Public `aggTrade` data is post-match. This project makes no front-running or queue-priority claim.
- A positive backtest result is a measurement, not a guaranteed return.
- There is no live order path here. Any execution layer must be added separately, explicitly guarded, and tested first.
- No API key is required for the public data used here.
