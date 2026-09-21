import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDirectionalAnalysis,
  createState,
  ingestAggTrade,
  ingestDepth,
  ingestLiquidation,
  ingestOpenInterest,
} from '../src/analysis.js';

function levels(price, quantity) {
  return Array.from({ length: 10 }, (_, index) => [price + index * 0.1, quantity]);
}

function seedReadyState() {
  const state = createState('BTCUSDT');
  ingestDepth(state, {
    bids: levels(99.9, 10),
    asks: levels(100, 1),
    updateId: 1,
    eventTimeMs: 1_000,
  });
  ingestAggTrade(state, {
    price: 100,
    quantity: 1,
    isBuyerMaker: false,
    eventTimeMs: 1_000,
  });
  ingestOpenInterest(state, { value: 1_000, eventTimeMs: 1_000 });
  ingestDepth(state, {
    bids: levels(100.9, 10),
    asks: levels(101, 1),
    updateId: 2,
    eventTimeMs: 2_000,
  });
  ingestAggTrade(state, {
    price: 101,
    quantity: 2,
    isBuyerMaker: true,
    eventTimeMs: 2_000,
  });
  ingestOpenInterest(state, { value: 990, eventTimeMs: 2_000 });
  return state;
}

test('does not emit a demo result before real data is ready', () => {
  const result = calculateDirectionalAnalysis(createState('BTCUSDT'), 1_000);
  assert.equal(result.status, 'DATA_INCOMPLETE');
  assert.equal(result.dataQuality.isReady, false);
});

test('computes real-data readiness and exposes CVD divergence', () => {
  const result = calculateDirectionalAnalysis(seedReadyState(), 2_100);
  assert.equal(result.status, 'READY');
  assert.equal(result.dataQuality.isReady, true);
  assert.equal(result.metrics.cvd.status, 'DIVERGENCE');
  assert.ok(result.metrics.cvd.score < 0);
});

test('uses liquidation notional and distance instead of a fixed dollar trigger', () => {
  const state = seedReadyState();
  ingestLiquidation(state, {
    side: 'SELL',
    price: 101,
    quantity: 100,
    eventTimeMs: 2_050,
  });
  const result = calculateDirectionalAnalysis(state, 2_100);
  assert.equal(result.metrics.liquidation.status, 'NEAR_LIQUIDATION_FLOW');
  assert.ok(result.metrics.liquidation.sellNotional > result.metrics.liquidation.buyNotional);
  assert.ok(result.metrics.liquidation.score < 0);
});

test('rejects duplicate or out-of-order depth updates', () => {
  const state = createState('BTCUSDT');
  ingestDepth(state, {
    bids: levels(99.9, 1),
    asks: levels(100, 1),
    updateId: 4,
    eventTimeMs: 1_000,
  });
  ingestDepth(state, {
    bids: levels(99.9, 2),
    asks: levels(100, 2),
    updateId: 4,
    eventTimeMs: 1_100,
  });
  assert.equal(state.health.depthSequenceOk, false);
  assert.equal(state.depth.bidVolumeTop10, 10);
});
