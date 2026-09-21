import test from 'node:test';
import assert from 'node:assert/strict';
import { replayEvents } from '../src/replay.js';

function levels(price, quantity, side) {
  return Array.from({ length: 10 }, (_, index) => [
    price + (side === 'bid' ? -index : index) * 0.1,
    quantity,
  ]);
}

function event(type, eventTimeMs, data) {
  return { type, eventTimeMs, data };
}

function risingEvents() {
  return [
    event('depth', 1_000, {
      bids: levels(99.9, 10, 'bid'),
      asks: levels(100, 1, 'ask'),
      updateId: 1,
    }),
    event('aggTrade', 1_000, {
      price: 100,
      quantity: 1,
      isBuyerMaker: false,
    }),
    event('openInterest', 1_000, { value: 1_000 }),
    event('aggTrade', 2_000, {
      price: 101,
      quantity: 1,
      isBuyerMaker: false,
    }),
    event('openInterest', 2_000, { value: 1_001 }),
    event('aggTrade', 3_000, {
      price: 102,
      quantity: 1,
      isBuyerMaker: false,
    }),
    event('openInterest', 3_000, { value: 1_002 }),
    event('aggTrade', 4_000, {
      price: 103,
      quantity: 1,
      isBuyerMaker: false,
    }),
    event('openInterest', 4_000, { value: 1_003 }),
    event('aggTrade', 5_000, {
      price: 104,
      quantity: 1,
      isBuyerMaker: false,
    }),
    event('openInterest', 5_000, { value: 1_004 }),
  ];
}

test('replays the same path and settles forward directional returns', () => {
  const result = replayEvents(risingEvents(), {
    config: {
      maxDepthAgeMs: 10_000,
      maxTradeAgeMs: 10_000,
      maxOiAgeMs: 10_000,
    },
    horizonMs: 1_000,
    predictionIntervalMs: 1_000,
  });

  assert.equal(result.processedEvents, 11);
  assert.ok(result.analyses.length >= 4);
  assert.equal(result.summary.totalPredictions, 4);
  assert.equal(result.summary.settledPredictions, 3);
  assert.equal(result.summary.pendingPredictions, 1);
  assert.ok(result.summary.directionalPredictions > 0);
  assert.ok(result.summary.averageSignedReturnBps > 0);
});

test('rejects out-of-order replay input instead of silently sorting it', () => {
  assert.throws(
    () => replayEvents([
      event('aggTrade', 2_000, { price: 100, quantity: 1, isBuyerMaker: false }),
      event('aggTrade', 1_000, { price: 100, quantity: 1, isBuyerMaker: false }),
    ]),
    /ordered by eventTimeMs/,
  );
});
