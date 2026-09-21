import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMetrics,
  createMetricState,
  ingestDepth,
  ingestLiquidation,
  ingestTrade,
} from './metrics.js';

function depth(updateId, eventTimeMs, { bidQuantity = 10, askQuantity = 10 } = {}) {
  const bids = Array.from({ length: 10 }, (_, index) => [100 - index * 0.1, bidQuantity]);
  const asks = Array.from({ length: 10 }, (_, index) => [100.1 + index * 0.1, askQuantity]);
  return { bids, asks, updateId, eventTimeMs };
}

function trade(eventTimeMs, { price = 100, quantity = 100, isBuyerMaker = false } = {}) {
  return { price, quantity, isBuyerMaker, eventTimeMs };
}

test('rejects fabricated or future trades instead of ingesting them', () => {
  const state = createMetricState('BTCUSDT', { spoofLifetimeMs: 8_000 });
  ingestTrade(state, trade(1_000_000), 1_000_000);
  ingestTrade(state, trade(5_000_000), 1_000_000);
  assert.equal(state.rejection.futureTrades, 1);
  assert.equal(state.trades.length, 1);
});

test('computes a real CVD z-score from per-second deltas', () => {
  const state = createMetricState('BTCUSDT', { cvdMinSamples: 5, cvdWindowMs: 60_000 });
  const nowMs = 60_000;
  for (let second = 0; second < 40; second += 1) {
    const eventTimeMs = nowMs - (40 - second) * 1_000;
    for (let index = 0; index < 2; index += 1) {
      ingestTrade(state, trade(eventTimeMs, { quantity: 10 + (second % 3) }), nowMs);
    }
  }
  const metrics = computeMetrics(state, nowMs);
  assert.equal(metrics.cvd.status, 'READY');
  assert.ok(metrics.cvd.secondsObserved > 5);
  assert.ok(Number.isFinite(metrics.cvd.zScore));
  assert.ok(metrics.cvd.zScore > 0);
});

test('computes microprice above mid when bid side is heavier', () => {
  const state = createMetricState('BTCUSDT');
  ingestDepth(state, depth(1, 1_000, { bidQuantity: 50, askQuantity: 5 }), 1_000);
  const metrics = computeMetrics(state, 1_000);
  assert.ok(metrics.microprice.value > metrics.microprice.mid);
  assert.ok(metrics.microprice.deviationBps > 0);
});

test('separates whale imbalance from retail imbalance', () => {
  const state = createMetricState('BTCUSDT', {
    cvdMinSamples: 1,
    layerThresholdsUsd: [1_000, 10_000, 100_000, 1_000_000],
  });
  const nowMs = 60_000;
  for (let index = 0; index < 10; index += 1) {
    ingestTrade(state, trade(nowMs - 1_000, { price: 100, quantity: 5, isBuyerMaker: true }), nowMs);
  }
  ingestTrade(state, trade(nowMs - 1_000, { price: 100, quantity: 50_000, isBuyerMaker: false }), nowMs);
  const metrics = computeMetrics(state, nowMs);
  assert.ok(metrics.layers.whaleImbalance > 0);
  assert.ok(metrics.layers.retailImbalance < 0);
  assert.ok(metrics.layers.divergence > 0);
});

test('detects a spoofed wall that shrinks inside the lifetime window', () => {
  const state = createMetricState('BTCUSDT', {
    spoofMinNotionalUsd: 100_000,
    spoofShrinkFraction: 0.5,
    spoofLifetimeMs: 8_000,
    spoofDistanceBps: 100,
    cvdWindowMs: 60_000,
  });

  const bigBids = Array.from({ length: 10 }, (_, index) => [100 - index * 0.1, index === 0 ? 3_000 : 1]);
  const asks = Array.from({ length: 10 }, (_, index) => [100.1 + index * 0.1, 1]);
  ingestDepth(state, { bids: bigBids, asks, updateId: 1, eventTimeMs: 1_000 }, 1_000);

  const smallBids = Array.from({ length: 10 }, (_, index) => [100 - index * 0.1, 1]);
  ingestDepth(state, { bids: smallBids, asks, updateId: 2, eventTimeMs: 3_000 }, 3_000);

  const metrics = computeMetrics(state, 3_000);
  assert.equal(metrics.spoof.detected, true);
  assert.equal(metrics.spoof.last.side, 'BID');
  assert.ok(metrics.spoof.last.shrink >= 0.5);
});

test('ignores duplicate depth update ids', () => {
  const state = createMetricState('BTCUSDT');
  assert.equal(ingestDepth(state, depth(5, 1_000), 1_000), true);
  assert.equal(ingestDepth(state, depth(5, 2_000), 2_000), false);
  assert.equal(state.rejection.duplicateDepth, 1);
});

test('flags a liquidation cascade only when both count and notional clear the bar', () => {
  const state = createMetricState('BTCUSDT', {
    cascadeWindowMs: 5_000,
    cascadeMinEvents: 2,
    cascadeMinNotionalUsd: 100_000,
  });
  ingestLiquidation(state, { side: 'SELL', price: 100, quantity: 600, eventTimeMs: 1_000 }, 1_000);
  ingestLiquidation(state, { side: 'SELL', price: 100, quantity: 600, eventTimeMs: 2_000 }, 2_000);
  const metrics = computeMetrics(state, 3_000);
  assert.equal(metrics.cascade.detected, true);
  assert.equal(metrics.cascade.dominantSide, 'SELL');
  assert.ok(metrics.cascade.sellNotionalUsd >= 100_000);
});
