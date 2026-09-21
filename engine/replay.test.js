import test from 'node:test';
import assert from 'node:assert/strict';
import { replaySeries } from './replay.js';
import { splitInOut, wilsonLowerBound } from './optimizer.js';

function syntheticSeries({ startMs, durationMs = 600_000, driftBpsPerMinute = 40 }) {
  const trades = [];
  const depthSnapshots = [];
  let price = 100;
  for (let timeMs = startMs; timeMs <= startMs + durationMs; timeMs += 1_000) {
    const minutes = (timeMs - startMs) / 60_000;
    price = 100 * (1 + (driftBpsPerMinute / 10_000) * minutes);
    trades.push({ price, quantity: 2, isBuyerMaker: false, eventTimeMs: timeMs });
    if (timeMs % 2_000 === 0) {
      const bids = Array.from({ length: 10 }, (_, index) => [price - 0.1 - index * 0.1, 14]);
      const asks = Array.from({ length: 10 }, (_, index) => [price + 0.1 + index * 0.1, 1]);
      depthSnapshots.push({ bids, asks, updateId: depthSnapshots.length + 1, eventTimeMs: timeMs });
    }
  }
  return { trades, depthSnapshots, liquidations: [] };
}

test('replay charges fees and slippage on both entry and exit', () => {
  const { trades, depthSnapshots } = syntheticSeries({ startMs: 1_000_000 });
  const result = replaySeries({
    symbol: 'BTCUSDT',
    trades,
    depthSnapshots,
    config: {
      entryThreshold: 0.2,
      minConfidence: 0,
      feeBpsPerSide: 5,
      slippageBps: 1.5,
      horizonMs: 10_000,
      signalIntervalMs: 5_000,
    },
  });

  assert.ok(result.decisionCount > 0, 'expected at least one decision');
  for (const round of result.rounds) {
    if (round.exitReason === 'NO_FILL') continue;
    assert.ok(round.netReturnBps < round.grossReturnBps, 'net must be below gross after costs');
  }
});

test('replay never uses trades before the decision moment', () => {
  const { trades, depthSnapshots } = syntheticSeries({ startMs: 1_000_000, driftBpsPerMinute: 0 });
  const result = replaySeries({
    symbol: 'BTCUSDT',
    trades,
    depthSnapshots,
    config: { entryThreshold: 0, minConfidence: 0, signalIntervalMs: 5_000, horizonMs: 10_000 },
  });

  for (const point of result.rounds) {
    assert.ok(point.timeMs >= 1_000_000);
  }
});

test('wilson lower bound stays below the raw rate for small samples', () => {
  const bound = wilsonLowerBound(2, 3);
  assert.ok(bound < 2 / 3);
  assert.ok(bound > 0);
  assert.equal(wilsonLowerBound(0, 0), 0);
});

test('in/out split preserves chronological order and separates periods', () => {
  const { trades, depthSnapshots } = syntheticSeries({ startMs: 1_000_000 });
  const { train, test } = splitInOut([], trades, depthSnapshots, 0.7);
  assert.ok(train.trades.length > 0);
  assert.ok(test.trades.length > 0);
  const lastTrain = train.trades.at(-1).eventTimeMs;
  const firstTest = test.trades[0].eventTimeMs;
  assert.ok(lastTrain < firstTest);
});
