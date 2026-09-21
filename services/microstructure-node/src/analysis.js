const DEFAULT_CONFIG = Object.freeze({
  flowWindowMs: 300_000,
  liquidationWindowMs: 60_000,
  maxLiquidationHistoryMs: 120_000,
  oiWindowMs: 300_000,
  maxDepthAgeMs: 500,
  maxTradeAgeMs: 1_000,
  maxOiAgeMs: 15_000,
  priceScale: 0.001,
  flowScale: 0.35,
  oiScale: 0.0025,
  liquidationProximity: 0.003,
  liquidationRateLookbackMs: 900_000,
  weights: Object.freeze({
    obi: 0.30,
    cvd: 0.40,
    liquidation: 0.20,
    oi: 0.10,
  }),
});

export function createState(symbol, config = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...config,
    weights: { ...DEFAULT_CONFIG.weights, ...(config.weights ?? {}) },
  };
  return {
    symbol: symbol.toUpperCase(),
    config: merged,
    lastPrice: 0,
    lastTradeTimeMs: 0,
    lastDepthTimeMs: 0,
    lastOiTimeMs: 0,
    lastEventTimeMs: 0,
    cvd: 0,
    flowBuckets: new Map(),
    flowSamples: [],
    lastFlowSampleTimeMs: 0,
    depth: {
      bestBid: 0,
      bestAsk: 0,
      bidVolumeTop10: 0,
      askVolumeTop10: 0,
      updateId: 0,
    },
    liquidations: [],
    liquidationRateEma: 0,
    oiSamples: [],
    health: {
      depthSequenceOk: true,
      streamErrors: 0,
    },
  };
}

export function ingestAggTrade(state, trade) {
  const price = finitePositive(trade.price, 'trade price');
  const quantity = finitePositive(trade.quantity, 'trade quantity');
  const eventTimeMs = finiteTimestamp(trade.eventTimeMs);
  const signedQuantity = trade.isBuyerMaker ? -quantity : quantity;
  const bucketStart = Math.floor(eventTimeMs / 1_000) * 1_000;
  const bucket = state.flowBuckets.get(bucketStart) ?? {
    buyQuantity: 0,
    sellQuantity: 0,
    deltaQuantity: 0,
    notional: 0,
  };

  if (signedQuantity >= 0) bucket.buyQuantity += quantity;
  else bucket.sellQuantity += quantity;
  bucket.deltaQuantity += signedQuantity;
  bucket.notional += price * quantity;
  state.flowBuckets.set(bucketStart, bucket);
  state.cvd += signedQuantity;
  state.lastPrice = price;
  state.lastTradeTimeMs = eventTimeMs;
  state.lastEventTimeMs = Math.max(state.lastEventTimeMs, eventTimeMs);

  pruneFlow(state, eventTimeMs);
  if (
    state.lastFlowSampleTimeMs === 0 ||
    eventTimeMs - state.lastFlowSampleTimeMs >= 1_000
  ) {
    state.flowSamples.push({
      timeMs: eventTimeMs,
      price,
      cvd: state.cvd,
    });
    state.lastFlowSampleTimeMs = eventTimeMs;
  }
}

export function ingestDepth(state, depth) {
  const eventTimeMs = finiteTimestamp(depth.eventTimeMs);
  const updateId = Number(depth.updateId);
  if (!Number.isSafeInteger(updateId) || updateId <= 0) {
    throw new TypeError('depth update id must be a positive integer');
  }
  if (state.depth.updateId > 0 && updateId <= state.depth.updateId) {
    state.health.depthSequenceOk = false;
    return;
  }

  const bids = normalizeLevels(depth.bids);
  const asks = normalizeLevels(depth.asks);
  if (bids.length < 10 || asks.length < 10) {
    throw new TypeError('depth stream must contain at least ten bid and ask levels');
  }

  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  if (bestBid <= 0 || bestAsk <= 0 || bestBid > bestAsk) {
    throw new TypeError('depth spread is invalid');
  }

  state.depth = {
    bestBid,
    bestAsk,
    bidVolumeTop10: bids.slice(0, 10).reduce((sum, level) => sum + level[1], 0),
    askVolumeTop10: asks.slice(0, 10).reduce((sum, level) => sum + level[1], 0),
    updateId,
  };
  state.lastDepthTimeMs = eventTimeMs;
  state.lastEventTimeMs = Math.max(state.lastEventTimeMs, eventTimeMs);
}

export function ingestLiquidation(state, liquidation) {
  const side = liquidation.side;
  if (side !== 'BUY' && side !== 'SELL') {
    throw new TypeError('liquidation side must be BUY or SELL');
  }
  const price = finitePositive(liquidation.price, 'liquidation price');
  const quantity = finitePositive(liquidation.quantity, 'liquidation quantity');
  const eventTimeMs = finiteTimestamp(liquidation.eventTimeMs);
  state.liquidations.push({ side, price, quantity, eventTimeMs });
  state.liquidations = state.liquidations.filter(
    (event) => eventTimeMs - event.eventTimeMs <= state.config.maxLiquidationHistoryMs,
  );
  state.lastEventTimeMs = Math.max(state.lastEventTimeMs, eventTimeMs);
}

export function ingestOpenInterest(state, openInterest) {
  const value = finitePositive(openInterest.value, 'open interest');
  const eventTimeMs = finiteTimestamp(openInterest.eventTimeMs);
  state.oiSamples.push({ timeMs: eventTimeMs, value, price: state.lastPrice });
  state.oiSamples = state.oiSamples.filter(
    (sample) => eventTimeMs - sample.timeMs <= state.config.oiWindowMs,
  );
  state.lastOiTimeMs = eventTimeMs;
  state.lastEventTimeMs = Math.max(state.lastEventTimeMs, eventTimeMs);
}

export function calculateDirectionalAnalysis(state, nowMs = Date.now()) {
  const dataQuality = getDataQuality(state, nowMs);
  if (!dataQuality.isReady) {
    return {
      status: 'DATA_INCOMPLETE',
      symbol: state.symbol,
      timestamp: nowMs,
      dataQuality,
    };
  }

  const metrics = {
    obi: calculateObi(state),
    cvd: calculateCvdSignal(state, nowMs),
    liquidation: calculateLiquidationSignal(state, nowMs),
    oi: calculateOiSignal(state, nowMs),
  };
  const score = clamp(
    metrics.obi.score * state.config.weights.obi +
      metrics.cvd.score * state.config.weights.cvd +
      metrics.liquidation.score * state.config.weights.liquidation +
      metrics.oi.score * state.config.weights.oi,
    -100,
    100,
  );
  const direction = score >= 20 ? 'LONG_BIAS' : score <= -20 ? 'SHORT_BIAS' : 'NEUTRAL';

  return {
    status: 'READY',
    symbol: state.symbol,
    timestamp: nowMs,
    price: state.lastPrice,
    score: round(score, 4),
    signalStrength: round(Math.abs(score), 4),
    direction,
    dataQuality,
    metrics,
  };
}

export function getDataQuality(state, nowMs) {
  const depthAgeMs = age(nowMs, state.lastDepthTimeMs);
  const tradeAgeMs = age(nowMs, state.lastTradeTimeMs);
  const oiAgeMs = age(nowMs, state.lastOiTimeMs);
  const hasFlowWindow = state.flowSamples.length >= 2;
  const hasOiWindow = state.oiSamples.filter((sample) => sample.price > 0).length >= 2;
  return {
    isReady:
      state.lastPrice > 0 &&
      state.depth.updateId > 0 &&
      hasFlowWindow &&
      hasOiWindow &&
      depthAgeMs <= state.config.maxDepthAgeMs &&
      tradeAgeMs <= state.config.maxTradeAgeMs &&
      oiAgeMs <= state.config.maxOiAgeMs &&
      state.health.depthSequenceOk,
    hasPrice: state.lastPrice > 0,
    hasDepth: state.depth.updateId > 0,
    hasTrades: state.lastTradeTimeMs > 0 && hasFlowWindow,
    hasOpenInterest: hasOiWindow,
    isDepthFresh: depthAgeMs <= state.config.maxDepthAgeMs,
    isTradeFresh: tradeAgeMs <= state.config.maxTradeAgeMs,
    isOpenInterestFresh: oiAgeMs <= state.config.maxOiAgeMs,
    isDepthSequenceHealthy: state.health.depthSequenceOk,
    depthAgeMs,
    tradeAgeMs,
    openInterestAgeMs: oiAgeMs,
  };
}

function calculateObi(state) {
  const total = state.depth.bidVolumeTop10 + state.depth.askVolumeTop10;
  const value = total > 0 ? (state.depth.bidVolumeTop10 - state.depth.askVolumeTop10) / total : 0;
  return {
    value: round(value, 6),
    score: round(value * 100, 4),
    bidVolumeTop10: round(state.depth.bidVolumeTop10, 8),
    askVolumeTop10: round(state.depth.askVolumeTop10, 8),
  };
}

function calculateCvdSignal(state, nowMs) {
  const samples = state.flowSamples.filter(
    (sample) => nowMs - sample.timeMs <= state.config.flowWindowMs,
  );
  if (samples.length < 2) return { score: 0, status: 'INSUFFICIENT_DATA' };
  const first = samples[0];
  const last = samples[samples.length - 1];
  const priceReturn = last.price / first.price - 1;
  const cvdDelta = last.cvd - first.cvd;
  const totalFlow = [...state.flowBuckets.entries()]
    .filter(([timeMs]) => nowMs - timeMs <= state.config.flowWindowMs)
    .reduce((sum, [, bucket]) => sum + bucket.buyQuantity + bucket.sellQuantity, 0);
  const flowRatio = totalFlow > 0 ? cvdDelta / totalFlow : 0;
  const priceComponent = clamp(priceReturn / state.config.priceScale, -1, 1);
  const flowComponent = clamp(flowRatio / state.config.flowScale, -1, 1);
  const score = clamp((priceComponent * 0.4 + flowComponent * 0.6) * 100, -100, 100);
  const divergent = priceComponent * flowComponent < -0.12;
  return {
    score: round(score, 4),
    status: divergent ? 'DIVERGENCE' : 'ALIGNED_OR_FLAT',
    priceReturn: round(priceReturn, 8),
    cvdDelta: round(cvdDelta, 8),
    flowRatio: round(flowRatio, 8),
  };
}

function calculateLiquidationSignal(state, nowMs) {
  const recent = state.liquidations.filter(
    (event) => nowMs - event.eventTimeMs <= state.config.liquidationWindowMs,
  );
  if (recent.length === 0) {
    return { score: 0, status: 'NO_PUBLIC_LIQUIDATION_EVENT', notional: 0 };
  }

  let buyNotional = 0;
  let sellNotional = 0;
  let totalQuantity = 0;
  let weightedPrice = 0;
  for (const event of recent) {
    const notional = event.price * event.quantity;
    if (event.side === 'BUY') buyNotional += notional;
    else sellNotional += notional;
    totalQuantity += event.quantity;
    weightedPrice += event.price * event.quantity;
  }

  const totalNotional = buyNotional + sellNotional;
  const pressure = totalNotional > 0 ? (buyNotional - sellNotional) / totalNotional : 0;
  const centerPrice = totalQuantity > 0 ? weightedPrice / totalQuantity : state.lastPrice;
  const distance = Math.abs(state.lastPrice / centerPrice - 1);
  const proximity = clamp(1 - distance / state.config.liquidationProximity, 0, 1);
  const ratePerSecond = totalNotional / (state.config.liquidationWindowMs / 1_000);
  state.liquidationRateEma = state.liquidationRateEma === 0
    ? ratePerSecond
    : state.liquidationRateEma * 0.9 + ratePerSecond * 0.1;
  const rateMultiplier = clamp(ratePerSecond / Math.max(state.liquidationRateEma, 1), 0, 3) / 3;
  const score = pressure * proximity * rateMultiplier * 100;
  return {
    score: round(score, 4),
    status: proximity > 0 ? 'NEAR_LIQUIDATION_FLOW' : 'DISTANT_LIQUIDATION_FLOW',
    notional: round(totalNotional, 4),
    buyNotional: round(buyNotional, 4),
    sellNotional: round(sellNotional, 4),
    centerPrice: round(centerPrice, 8),
    proximity: round(proximity, 6),
    rateMultiplier: round(rateMultiplier, 6),
  };
}

function calculateOiSignal(state, nowMs) {
  const samples = state.oiSamples.filter(
    (sample) => nowMs - sample.timeMs <= state.config.oiWindowMs && sample.price > 0,
  );
  if (samples.length < 2) return { score: 0, status: 'INSUFFICIENT_DATA' };
  const first = samples[0];
  const last = samples[samples.length - 1];
  const priceReturn = last.price > 0 && first.price > 0 ? last.price / first.price - 1 : 0;
  const oiReturn = first.value > 0 ? last.value / first.value - 1 : 0;
  const priceComponent = clamp(priceReturn / state.config.priceScale, -1, 1);
  const oiComponent = clamp(oiReturn / state.config.oiScale, -1, 1);
  const score = clamp(priceComponent * oiComponent * 100, -100, 100);
  return {
    score: round(score, 4),
    status: priceComponent * oiComponent < 0 ? 'DIVERGENCE' : 'ALIGNED_OR_FLAT',
    priceReturn: round(priceReturn, 8),
    openInterestReturn: round(oiReturn, 8),
  };
}

function pruneFlow(state, nowMs) {
  const cutoff = nowMs - state.config.flowWindowMs;
  for (const timeMs of state.flowBuckets.keys()) {
    if (timeMs < cutoff) state.flowBuckets.delete(timeMs);
  }
  state.flowSamples = state.flowSamples.filter((sample) => sample.timeMs >= cutoff);
}

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) throw new TypeError('depth levels must be an array');
  return levels.map((level) => {
    if (!Array.isArray(level) || level.length < 2) throw new TypeError('invalid depth level');
    return [finitePositive(level[0], 'depth price'), finitePositive(level[1], 'depth quantity')];
  });
}

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${label} must be positive`);
  return number;
}

function finiteTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError('event timestamp must be a positive integer');
  }
  return timestamp;
}

function age(nowMs, eventTimeMs) {
  if (!eventTimeMs || nowMs < eventTimeMs) return Number.POSITIVE_INFINITY;
  return nowMs - eventTimeMs;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}
