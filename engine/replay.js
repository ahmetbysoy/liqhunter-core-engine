import { computeMetrics, createMetricState, ingestLiquidation, ingestTrade } from './metrics.js';

export const DEFAULT_REPLAY_CONFIG = Object.freeze({
  horizonMs: 60_000,
  signalIntervalMs: 5_000,
  feeBpsPerSide: 5,
  slippageBps: 1.5,
  entryThreshold: 0.55,
  exitThreshold: 0.15,
  minConfidence: 0.2,
  maxPositionMs: 300_000,
  positionNotionalUsd: 10_000,
});

export function replaySeries({ symbol, trades, depthSnapshots = [], liquidations = [], config = {} }) {
  const replayConfig = { ...DEFAULT_REPLAY_CONFIG, ...config };
  const state = createMetricState(symbol, replayConfig.metricConfig ?? {});
  const depthByTime = indexByTime(depthSnapshots);
  const liquidationByTime = indexByTime(liquidations);

  const rounds = [];
  const decisionPoints = [];
  const events = [
    ...trades.map((trade) => ({ kind: 'trade', timeMs: trade.eventTimeMs, payload: trade })),
    ...depthSnapshots.map((snapshot) => ({ kind: 'depth', timeMs: snapshot.eventTimeMs, payload: snapshot })),
    ...liquidations.map((event) => ({ kind: 'liquidation', timeMs: event.eventTimeMs, payload: event })),
  ].sort((left, right) => left.timeMs - right.timeMs);

  if (events.length === 0) {
    return emptyResult(symbol, replayConfig);
  }

  let lastSignalAtMs = 0;

  for (const event of events) {
    const nowMs = event.timeMs;

    if (event.kind === 'trade') {
      ingestTrade(state, event.payload, nowMs);
    } else if (event.kind === 'depth') {
      try {
        state.bids = normalize(event.payload.bids);
        state.asks = normalize(event.payload.asks);
        state.bestBid = state.bids[0]?.[0] ?? 0;
        state.bestAsk = state.asks[0]?.[0] ?? 0;
        state.depthUpdateId += 1;
        state.lastDepthTimeMs = nowMs;
      } catch {
        continue;
      }
    } else {
      ingestLiquidation(state, event.payload, nowMs);
    }

    if (lastSignalAtMs !== 0 && nowMs - lastSignalAtMs < replayConfig.signalIntervalMs) continue;
    lastSignalAtMs = nowMs;

    if (state.lastDepthTimeMs === 0 || state.lastTradeTimeMs === 0) continue;
    if (nowMs - state.lastDepthTimeMs > replayConfig.signalIntervalMs * 2) continue;

    const metrics = computeMetrics(state, nowMs);
    const score = scoreMetrics(metrics);
    if (Math.abs(score) < replayConfig.entryThreshold) continue;

    const direction = score > 0 ? 'LONG' : 'SHORT';
    const entry = simulatedEntry(state, direction, replayConfig);
    const exit = settleForward({
      direction,
      entryPrice: entry.price,
      entryAtMs: nowMs,
      tradesByTime: indexByTime(trades),
      horizonMs: replayConfig.horizonMs,
      maxPositionMs: replayConfig.maxPositionMs,
      feeBpsPerSide: replayConfig.feeBpsPerSide,
      slippageBps: replayConfig.slippageBps,
      entryThreshold: replayConfig.entryThreshold,
      exitThreshold: replayConfig.exitThreshold,
      minConfidence: replayConfig.minConfidence,
      scoreAtEntry: score,
    });

    decisionPoints.push({
      timeMs: nowMs,
      direction,
      score,
      entry: { ...entry, ...exit },
      metrics: condensedMetrics(metrics),
    });
  }

  for (const point of decisionPoints) {
    rounds.push({
      timeMs: point.timeMs,
      direction: point.direction,
      score: point.score,
      grossReturnBps: point.entry.grossReturnBps,
      netReturnBps: point.entry.netReturnBps,
      holdingMs: point.entry.holdingMs,
      exitReason: point.entry.exitReason,
    });
  }

  return buildResult(symbol, replayConfig, decisionPoints, rounds);
}

function settleForward({
  direction,
  entryPrice,
  entryAtMs,
  tradesByTime,
  horizonMs,
  maxPositionMs,
  feeBpsPerSide,
  slippageBps,
  scoreAtEntry,
}) {
  const settlementTargetMs = entryAtMs + horizonMs;
  const hardStopMs = entryAtMs + maxPositionMs;
  let entryCostBps = slippageBps;
  let exitCostBps = slippageBps;
  let exitPrice = null;
  let exitAtMs = null;
  let exitReason = 'NO_FILL';

  for (let timeMs = entryAtMs + 1; timeMs <= hardStopMs; timeMs += 1_000) {
    const trades = tradesByTime.get(timeMs);
    if (!trades || trades.length === 0) continue;
    const price = trades[trades.length - 1].price;

    if (timeMs >= settlementTargetMs) {
      exitPrice = price;
      exitAtMs = timeMs;
      exitReason = 'HORIZON';
      break;
    }

    const adverse = direction === 'LONG' ? entryPrice / price - 1 : price / entryPrice - 1;
    if (adverse >= 0.02) {
      exitPrice = price;
      exitAtMs = timeMs;
      exitReason = 'STOP_LOSS';
      break;
    }
  }

  if (exitPrice === null) {
    const lastTime = entryAtMs + maxPositionMs;
    const fallback = tradesByTime.get(lastTime);
    if (fallback && fallback.length > 0) {
      exitPrice = fallback[fallback.length - 1].price;
      exitAtMs = lastTime;
      exitReason = 'TIME_EXIT';
    } else {
      return {
        grossReturnBps: 0,
        netReturnBps: 0,
        holdingMs: 0,
        exitReason: 'NO_FILL',
        entryCostBps,
        exitCostBps,
      };
    }
  }

  const rawReturn = direction === 'LONG'
    ? exitPrice / entryPrice - 1
    : entryPrice / exitPrice - 1;
  const grossReturnBps = rawReturn * 10_000;
  const netReturnBps = grossReturnBps - (feeBpsPerSide * 2 + entryCostBps + exitCostBps);

  return {
    grossReturnBps: round(grossReturnBps, 6),
    netReturnBps: round(netReturnBps, 6),
    holdingMs: exitAtMs - entryAtMs,
    exitReason,
    entryCostBps,
    exitCostBps,
    exitPrice,
    scoreAtEntry,
  };
}

function simulatedEntry(state, direction, config) {
  const reference = direction === 'LONG' ? state.bestAsk || state.lastTradePrice : state.bestBid || state.lastTradePrice;
  const slip = reference * (config.slippageBps / 10_000);
  const price = direction === 'LONG' ? reference + slip : reference - slip;
  return { price: round(price, 10), reference: round(reference, 10) };
}

function scoreMetrics(metrics) {
  const cvdZ = clamp(metrics.cvd.zScore / 3, -1, 1);
  const obi = clamp(metrics.obi.value, -1, 1);
  const whale = clamp(metrics.layers.whaleImbalance, -1, 1);
  const divergence = clamp(metrics.layers.divergence, -1, 1);
  const micro = clamp(metrics.microprice.deviationBps / 10, -1, 1);
  const spoofPenalty = metrics.spoof.detected
    ? (metrics.spoof.last?.side === 'BID' ? -0.25 : 0.25)
    : 0;

  const raw = cvdZ * 0.30
    + obi * 0.20
    + whale * 0.20
    + divergence * 0.15
    + micro * 0.15
    + spoofPenalty;

  return clamp(raw, -1, 1);
}

function condensedMetrics(metrics) {
  return {
    cvdZScore: round(metrics.cvd.zScore, 6),
    obi: round(metrics.obi.value, 6),
    micropriceDeviationBps: round(metrics.microprice.deviationBps, 6),
    whaleImbalance: round(metrics.layers.whaleImbalance, 6),
    retailImbalance: round(metrics.layers.retailImbalance, 6),
    divergence: round(metrics.layers.divergence, 6),
    spoofDetected: metrics.spoof.detected,
    absorptionDetected: metrics.absorption.detected,
    cascadeDetected: metrics.cascade.detected,
  };
}

function buildResult(symbol, config, decisionPoints, rounds) {
  const settled = rounds.filter((round) => round.exitReason !== 'NO_FILL');
  const wins = settled.filter((round) => round.netReturnBps > 0).length;
  const grossSum = settled.reduce((sum, round) => sum + round.grossReturnBps, 0);
  const netSum = settled.reduce((sum, round) => sum + round.netReturnBps, 0);
  const longCount = rounds.filter((round) => round.direction === 'LONG').length;
  const shortCount = rounds.filter((round) => round.direction === 'SHORT').length;

  return {
    symbol,
    config,
    decisionCount: decisionPoints.length,
    settledCount: settled.length,
    longCount,
    shortCount,
    wins,
    losses: settled.length - wins,
    winRate: settled.length > 0 ? round(wins / settled.length, 6) : 0,
    grossReturnSumBps: round(grossSum, 6),
    netReturnSumBps: round(netSum, 6),
    averageNetReturnBps: settled.length > 0 ? round(netSum / settled.length, 6) : 0,
    rounds,
  };
}

function emptyResult(symbol, config) {
  return {
    symbol,
    config,
    decisionCount: 0,
    settledCount: 0,
    longCount: 0,
    shortCount: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    grossReturnSumBps: 0,
    netReturnSumBps: 0,
    averageNetReturnBps: 0,
    rounds: [],
  };
}

function indexByTime(rows) {
  const map = new Map();
  for (const row of rows) {
    const timeMs = Math.floor(row.eventTimeMs / 1_000) * 1_000;
    const bucket = map.get(timeMs);
    if (bucket) bucket.push(row);
    else map.set(timeMs, [row]);
  }
  return map;
}

function normalize(levels) {
  if (!Array.isArray(levels) || levels.length === 0) throw new TypeError('levels required');
  return levels
    .map((level) => [Number(level[0]), Number(level[1])])
    .filter(([price, quantity]) => Number.isFinite(price) && Number.isFinite(quantity) && price > 0 && quantity > 0)
    .sort((left, right) => right[0] - left[0]);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}
