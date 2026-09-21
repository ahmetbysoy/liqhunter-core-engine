import { replaySeries } from './replay.js';

export const WILSON_Z_95 = 1.959963984540054;

export function wilsonLowerBound(successes, trials, z = WILSON_Z_95) {
  if (trials <= 0) return 0;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const radius = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials);
  return Math.max(0, (centre - radius) / denominator);
}

export function splitInOut(liquidations, trades, depthSnapshots, trainRatio = 0.7) {
  const boundary = Math.floor(trades.length * trainRatio);
  const boundaryTimeMs = trades[boundary]?.eventTimeMs ?? Infinity;
  return {
    train: {
      trades: trades.slice(0, boundary),
      depthSnapshots: depthSnapshots.filter((snapshot) => snapshot.eventTimeMs <= boundaryTimeMs),
      liquidations: liquidations.filter((event) => event.eventTimeMs <= boundaryTimeMs),
    },
    test: {
      trades: trades.slice(boundary),
      depthSnapshots: depthSnapshots.filter((snapshot) => snapshot.eventTimeMs > boundaryTimeMs),
      liquidations: liquidations.filter((event) => event.eventTimeMs > boundaryTimeMs),
    },
  };
}

export function optimizeThresholds(
  { symbol, trades, depthSnapshots = [], liquidations = [] },
  {
    thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    metricConfig = {},
    minSettledTrades = 15,
    trainRatio = 0.7,
    selectionMetric = 'wilsonLowerBound',
  } = {},
) {
  if (!Array.isArray(trades) || trades.length === 0) {
    throw new TypeError('optimizer requires historical trades');
  }

  const { train, test } = splitInOut(liquidations, trades, depthSnapshots, trainRatio);

  const candidates = thresholds.map((entryThreshold) => {
    const trainResult = replaySeries({
      symbol,
      trades: train.trades,
      depthSnapshots: train.depthSnapshots,
      liquidations: train.liquidations,
      config: { entryThreshold, metricConfig },
    });
    const testResult = replaySeries({
      symbol,
      trades: test.trades,
      depthSnapshots: test.depthSnapshots,
      liquidations: test.liquidations,
      config: { entryThreshold, metricConfig },
    });

    const trainSettled = trainResult.settledCount;
    const testSettled = testResult.settledCount;
    const trainWilson = wilsonLowerBound(trainResult.wins, trainSettled);
    const testWilson = wilsonLowerBound(testResult.wins, testSettled);

    return {
      entryThreshold,
      train: {
        settledCount: trainSettled,
        winRate: trainResult.winRate,
        netReturnSumBps: trainResult.netReturnSumBps,
        averageNetReturnBps: trainResult.averageNetReturnBps,
        wilsonLowerBound: round(trainWilson, 6),
      },
      test: {
        settledCount: testSettled,
        winRate: testResult.winRate,
        netReturnSumBps: testResult.netReturnSumBps,
        averageNetReturnBps: testResult.averageNetReturnBps,
        wilsonLowerBound: round(testWilson, 6),
      },
      eligible: trainSettled >= minSettledTrades && testSettled >= Math.max(5, Math.floor(minSettledTrades / 3)),
    };
  });

  const eligible = candidates.filter((candidate) => candidate.eligible);
  const pool = eligible.length > 0 ? eligible : candidates;
  const score = (candidate) => (
    selectionMetric === 'netReturnSumBps'
      ? candidate.train.netReturnSumBps
      : candidate.train.wilsonLowerBound
  );
  const ranked = [...pool].sort((left, right) => score(right) - score(left));
  const best = ranked[0];

  return {
    symbol,
    trainTradeCount: train.trades.length,
    testTradeCount: test.trades.length,
    minSettledTrades,
    trainRatio,
    selectionMetric,
    candidates,
    best,
    confirmed: best.eligible
      && best.test.netReturnSumBps > 0
      && best.test.wilsonLowerBound > 0,
    note: 'Out-of-sample confirmation only. Positive results are not a profitability guarantee and do not include funding or queue-position risk.',
  };
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}
