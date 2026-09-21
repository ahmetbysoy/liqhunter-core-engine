import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BinanceHistoryClient, DataSourceUnavailableError } from './binance-history.js';
import { optimizeThresholds } from './optimizer.js';

const HOUR_MS = 3_600_000;

const symbol = (process.env.TARGET_SYMBOL ?? 'BTCUSDT').toUpperCase();
const lookbackHours = Number(process.env.LOOKBACK_HOURS ?? 168);
const outputDir = process.env.OUTPUT_DIR ?? 'artifacts';

if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
  throw new Error('LOOKBACK_HOURS must be a positive number');
}

const client = new BinanceHistoryClient();
const endTimeMs = Date.now() - 60_000;
const startTimeMs = endTimeMs - lookbackHours * HOUR_MS;

console.log(`[optimizer] symbol=${symbol} window=${lookbackHours}h`);

try {
  const trades = await client.fetchAggTrades({ symbol, startTimeMs, endTimeMs });
  console.log(`[optimizer] trades=${trades.length}`);

  if (trades.length < 1_000) {
    await writeStatus(outputDir, {
      status: 'SKIPPED_INSUFFICIENT_DATA',
      symbol,
      tradeCount: trades.length,
      reason: 'not enough trades for a meaningful replay',
    });
    console.warn('[optimizer] insufficient data; no report produced');
    process.exitCode = 0;
  } else {
    const depthSnapshots = await collectDepthSnapshots(client, symbol, trades);
    console.log(`[optimizer] depthSnapshots=${depthSnapshots.length}`);

    const liquidations = await client.fetchForceOrders({ symbol, startTimeMs, endTimeMs });
    console.log(`[optimizer] liquidations=${liquidations.length}`);

    const report = optimizeThresholds(
      { symbol, trades, depthSnapshots, liquidations },
      {
        thresholds: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        minSettledTrades: 15,
        trainRatio: 0.7,
      },
    );

    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `optimizer-${symbol}.json`);
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeStatus(outputDir, {
      status: 'OK',
      symbol,
      tradeCount: trades.length,
      bestThreshold: report.best.entryThreshold,
      confirmed: report.confirmed,
    });
    console.log(`[optimizer] report written to ${outputPath}`);
    console.log(`[optimizer] best threshold=${report.best.entryThreshold} confirmed=${report.confirmed}`);
  }
} catch (error) {
  if (error instanceof DataSourceUnavailableError) {
    await writeStatus(outputDir, {
      status: 'SKIPPED_DATA_SOURCE_UNAVAILABLE',
      symbol,
      reason: error.reason,
      detail: error.detail,
      hint: 'Run the engine from an egress location the exchange allows, or route requests through an approved proxy.',
    });
    console.warn(`[optimizer] ${error.message}`);
    console.warn('[optimizer] no report produced; this is an environment limit, not an engine failure');
    process.exitCode = 0;
  } else {
    throw error;
  }
}

async function writeStatus(dir, payload) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'status.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), ...payload }, null, 2)}\n`,
    'utf8',
  );
}

async function collectDepthSnapshots(historyClient, targetSymbol, tradeList) {
  const snapshots = [];
  const strideMs = 300_000;
  const firstMs = tradeList[0].eventTimeMs;
  const lastMs = tradeList[tradeList.length - 1].eventTimeMs;

  for (let timeMs = firstMs; timeMs < lastMs; timeMs += strideMs) {
    try {
      const book = await historyClient.request('/fapi/v1/depth', { symbol: targetSymbol, limit: 100 });
      snapshots.push({
        bids: book.bids.slice(0, 20),
        asks: book.asks.slice(0, 20),
        updateId: snapshots.length + 1,
        eventTimeMs: timeMs,
      });
    } catch (error) {
      if (error instanceof DataSourceUnavailableError) throw error;
      console.warn(`[optimizer] depth snapshot at ${timeMs} failed: ${error.message}`);
    }
  }
  return snapshots;
}
