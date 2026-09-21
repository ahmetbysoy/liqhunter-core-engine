const DEFAULT_CONFIG = Object.freeze({
  flowWindowMs: 300_000,
  liquidationWindowMs: 60_000,
  maxLiquidationHistoryMs: 120_000,
  oiWindowMs: 300_000,
  maxDepthAgeMs: 500,
  maxTradeAgeMs: 1_000,
  maxOiAgeMs: 15_000,
  priceScale: 0.001,
  lacvdScale: 0.35,
  oiScalePerMinute: 0.0025,
  liquidationProximity: 0.003,
  clusterSearchBps: 100,
  vpinBucketCount: 50,
  vpinWindowBuckets: 50,
  vpinMinBuckets: 20,
  vpinWarmupMs: 60_000,
  volatilityReferenceBps: 15,
  baseHoldTimeMs: 180_000,
  weights: Object.freeze({
    obi: 0.25,
    lacvd: 0.32,
    vpin: 0.18,
    liquidation: 0.15,
    oi: 0.10,
  }),
});

export function createState(symbol, config = {}) {
  return {
    symbol: symbol.toUpperCase(),
    config: {
      ...DEFAULT_CONFIG,
      ...config,
      weights: { ...DEFAULT_CONFIG.weights, ...(config.weights ?? {}) },
    },
    lastPrice: 0,
    lastTradeTimeMs: 0,
    lastDepthTimeMs: 0,
    lastOiTimeMs: 0,
    cvd: 0,
    lacvd: 0,
    flowBuckets: new Map(),
    flowSamples: [],
    lastFlowSampleTimeMs: 0,
    depth: {
      bids: [],
      asks: [],
      bestBid: 0,
      bestAsk: 0,
      bidVolumeTop5: 0,
      askVolumeTop5: 0,
      updateId: 0,
    },
    liquidations: [],
    liquidationRateEma: 0,
    oiSamples: [],
    impliedClusters: new Map(),
    vpin: {
      targetVolume: 0,
      currentVolume: 0,
      currentBuyVolume: 0,
      currentSellVolume: 0,
      completed: [],
    },
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
  const topFiveDepth = state.depth.bidVolumeTop5 + state.depth.askVolumeTop5;
  const adjustedQuantity = topFiveDepth > 0 ? quantity / topFiveDepth : 0;
  const signedAdjustedQuantity = Math.sign(signedQuantity) * adjustedQuantity;
  const bucketStart = Math.floor(eventTimeMs / 1_000) * 1_000;
  const bucket = state.flowBuckets.get(bucketStart) ?? {
    buyQuantity: 0,
    sellQuantity: 0,
    deltaQuantity: 0,
    adjustedBuyVolume: 0,
    adjustedSellVolume: 0,
    adjustedDelta: 0,
    notional: 0,
  };

  if (signedQuantity >= 0) {
    bucket.buyQuantity += quantity;
    bucket.adjustedBuyVolume += adjustedQuantity;
  } else {
    bucket.sellQuantity += quantity;
    bucket.adjustedSellVolume += adjustedQuantity;
  }
  bucket.deltaQuantity += signedQuantity;
  bucket.adjustedDelta += signedAdjustedQuantity;
  bucket.notional += price * quantity;
  state.cvd += signedQuantity;
  state.lacvd += signedAdjustedQuantity;
  updateVpin(state, quantity, signedQuantity >= 0, eventTimeMs);
  state.flowBuckets.set(bucketStart, bucket);
  state.lastPrice = price;
  state.lastTradeTimeMs = eventTimeMs;

  pruneFlow(state, eventTimeMs);
  if (
    state.lastFlowSampleTimeMs === 0 ||
    eventTimeMs - state.lastFlowSampleTimeMs >= 1_000
  ) {
    state.flowSamples.push({
      timeMs: eventTimeMs,
      price,
      cvd: state.cvd,
      lacvd: state.lacvd,
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

  const bids = normalizeLevels(depth.bids).sort((left, right) => right[0] - left[0]);
  const asks = normalizeLevels(depth.asks).sort((left, right) => left[0] - right[0]);
  if (bids.length < 10 || asks.length < 10) {
    throw new TypeError('depth stream must contain at least ten bid and ask levels');
  }
  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  if (bestBid <= 0 || bestAsk <= 0 || bestBid > bestAsk) {
    throw new TypeError('depth spread is invalid');
  }

  state.depth = {
    bids,
    asks,
    bestBid,
    bestAsk,
    bidVolumeTop5: bids.slice(0, 5).reduce((sum, level) => sum + level[1], 0),
    askVolumeTop5: asks.slice(0, 5).reduce((sum, level) => sum + level[1], 0),
    updateId,
  };
  state.lastDepthTimeMs = eventTimeMs;
}

export function ingestLiquidation(state, liquidation) {
  if (liquidation.side !== 'BUY' && liquidation.side !== 'SELL') {
    throw new TypeError('liquidation side must be BUY or SELL');
  }
  const eventTimeMs = finiteTimestamp(liquidation.eventTimeMs);
  state.liquidations.push({
    side: liquidation.side,
    price: finitePositive(liquidation.price, 'liquidation price'),
    quantity: finitePositive(liquidation.quantity, 'liquidation quantity'),
    eventTimeMs,
  });
  state.liquidations = state.liquidations.filter(
    (event) => eventTimeMs - event.eventTimeMs <= state.config.maxLiquidationHistoryMs,
  );
}

export function ingestOpenInterest(state, openInterest) {
  const value = finitePositive(openInterest.value, 'open interest');
  const eventTimeMs = finiteTimestamp(openInterest.eventTimeMs);
  const previous = state.oiSamples.at(-1);
  const price = state.lastPrice;
  state.oiSamples.push({ timeMs: eventTimeMs, value, price });
  state.oiSamples = state.oiSamples.filter(
    (sample) => eventTimeMs - sample.timeMs <= state.config.oiWindowMs,
  );

  if (previous && previous.value > 0 && value > previous.value && price > 0) {
    const binSize = price * 0.0005;
    const binPrice = Math.round(price / binSize) * binSize;
    const key = binPrice.toFixed(8);
    const cluster = state.impliedClusters.get(key) ?? {
      price: binPrice,
      openInterestAdded: 0,
      lastTimeMs: eventTimeMs,
    };
    cluster.openInterestAdded += value - previous.value;
    cluster.lastTimeMs = eventTimeMs;
    state.impliedClusters.set(key, cluster);
  }
  for (const [key, cluster] of state.impliedClusters) {
    if (eventTimeMs - cluster.lastTimeMs > state.config.oiWindowMs) {
      state.impliedClusters.delete(key);
    }
  }
  state.lastOiTimeMs = eventTimeMs;
}

export function calculateDirectionalAnalysis(state, nowMs = Date.now()) {
  const dataQuality = getDataQuality(state, nowMs);
  if (!dataQuality.isReady) {
    return {
      status: 'DATA_INCOMPLETE',
      symbol: state.symbol,
      timestamp_ms: nowMs,
      dataQuality,
    };
  }

  const volatility = calculateRealizedVolatility(state, nowMs);
  const metrics = {
    depthWeightedObi: calculateDepthWeightedObi(state),
    lacvd: calculateLacvdSignal(state, nowMs),
    vpin: calculateVpin(state),
    liquidation: calculateLiquidationSignal(state, nowMs),
    oi: calculateOiSignal(state, nowMs),
    volatility,
    impliedCluster: calculateImpliedCluster(state),
  };
  const weights = dynamicWeights(state.config.weights, volatility.ratio);
  const score = fuseEvidence([
    { value: metrics.depthWeightedObi.score, weight: weights.obi },
    { value: metrics.lacvd.score, weight: weights.lacvd },
    { value: metrics.vpin.score, weight: weights.vpin },
    { value: metrics.liquidation.score, weight: weights.liquidation },
    { value: metrics.oi.score, weight: weights.oi },
  ]);
  const direction = score >= 65
    ? 'AGGRESSIVE_LONG'
    : score >= 25
      ? 'LONG_BIAS'
      : score <= -65
        ? 'AGGRESSIVE_SHORT'
        : score <= -25
          ? 'SHORT_BIAS'
          : 'NEUTRAL';
  const primaryTrigger = choosePrimaryTrigger(metrics);
  const secondaryTrigger = chooseSecondaryTrigger(metrics, primaryTrigger);

  return {
    status: 'READY',
    symbol: state.symbol,
    timestamp_ms: nowMs,
    signal: {
      direction,
      confidence_score: round(Math.abs(score), 4),
      expected_move_bps: round(volatility.realizedBps * (0.5 + Math.abs(score) / 100), 4),
      max_hold_time_ms: Math.round(
        clamp(state.config.baseHoldTimeMs / (1 + volatility.ratio), 30_000, state.config.baseHoldTimeMs),
      ),
      primary_trigger: primaryTrigger,
      secondary_trigger: secondaryTrigger,
    },
    microstructure_proof: {
      lacvd_1m: metrics.lacvd.value,
      vpin_toxicity: metrics.vpin.value,
      depth_weighted_obi: metrics.depthWeightedObi.value,
      oi_delta_vs_price: metrics.oi.relationship,
      nearest_liquidation_cluster_bps: metrics.impliedCluster.distanceBps,
      inferred_cluster: metrics.impliedCluster.isInferred,
      realized_volatility_bps: volatility.realizedBps,
    },
    metrics,
    weights,
    dataQuality,
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

function calculateDepthWeightedObi(state) {
  const mid = (state.depth.bestBid + state.depth.bestAsk) / 2;
  const spread = state.depth.bestAsk - state.depth.bestBid;
  const minimumDistance = Math.max(spread / Math.max(mid, 1e-12), 1e-6);
  const weightedVolume = (levels) => levels.slice(0, 10).reduce((sum, [price, quantity]) => {
    const relativeDistance = Math.max(Math.abs(price - mid) / mid, minimumDistance);
    return sum + quantity / relativeDistance;
  }, 0);
  const bidWeighted = weightedVolume(state.depth.bids);
  const askWeighted = weightedVolume(state.depth.asks);
  const total = bidWeighted + askWeighted;
  const value = total > 0 ? (bidWeighted - askWeighted) / total : 0;
  return {
    value: round(value, 8),
    score: round(value * 100, 4),
    bidWeighted: round(bidWeighted, 8),
    askWeighted: round(askWeighted, 8),
  };
}

function calculateLacvdSignal(state, nowMs) {
  const cutoff = nowMs - state.config.flowWindowMs;
  const buckets = [...state.flowBuckets.entries()].filter(([timeMs]) => timeMs >= cutoff);
  const adjustedBuy = buckets.reduce((sum, [, bucket]) => sum + bucket.adjustedBuyVolume, 0);
  const adjustedSell = buckets.reduce((sum, [, bucket]) => sum + bucket.adjustedSellVolume, 0);
  const adjustedTotal = adjustedBuy + adjustedSell;
  if (adjustedTotal === 0 || state.flowSamples.length < 2) {
    return { value: 0, score: 0, status: 'INSUFFICIENT_DATA' };
  }
  const first = state.flowSamples.find((sample) => sample.timeMs >= cutoff) ?? state.flowSamples[0];
  const last = state.flowSamples.at(-1);
  const priceReturn = last.price / first.price - 1;
  const lacvd = (adjustedBuy - adjustedSell) / adjustedTotal;
  const priceComponent = clamp(priceReturn / state.config.priceScale, -1, 1);
  const lacvdComponent = clamp(lacvd / state.config.lacvdScale, -1, 1);
  const pressure = Math.tanh(
    priceComponent * 0.35 + lacvdComponent * 0.65,
  );
  return {
    value: round(lacvd, 8),
    score: round(pressure * 100, 4),
    status: priceReturn * lacvd < -0.0001 ? 'DIVERGENCE' : 'FLOW_ALIGNED_OR_FLAT',
    priceReturn: round(priceReturn, 8),
    adjustedBuyVolume: round(adjustedBuy, 8),
    adjustedSellVolume: round(adjustedSell, 8),
  };
}

function calculateVpin(state) {
  const buckets = state.vpin.completed;
  const firstSample = state.flowSamples[0];
  const lastSample = state.flowSamples.at(-1);
  const warmupMs = firstSample && lastSample ? lastSample.timeMs - firstSample.timeMs : 0;
  if (buckets.length < state.config.vpinMinBuckets || warmupMs < state.config.vpinWarmupMs) {
    return {
      value: 0,
      score: 0,
      status: 'INSUFFICIENT_DATA',
      completedBuckets: buckets.length,
    };
  }
  const value = buckets.reduce((sum, imbalance) => sum + imbalance, 0) / buckets.length;
  return {
    value: round(value, 8),
    score: round(value * 100, 4),
    status: value >= 0.7 ? 'TOXIC_FLOW' : 'NORMAL_FLOW',
    completedBuckets: buckets.length,
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
  return {
    score: round(pressure * proximity * rateMultiplier * 100, 4),
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
  if (samples.length < 2) return { score: 0, relationship: 'INSUFFICIENT_DATA' };
  const first = samples[0];
  const last = samples.at(-1);
  const elapsedMinutes = Math.max((last.timeMs - first.timeMs) / 60_000, 1 / 60_000);
  const priceReturn = last.price / first.price - 1;
  const oiReturn = last.value / first.value - 1;
  const oiRatePerMinute = oiReturn / elapsedMinutes;
  const priceComponent = clamp(priceReturn / state.config.priceScale, -1, 1);
  const oiComponent = clamp(oiRatePerMinute / state.config.oiScalePerMinute, -1, 1);
  const relationship = classifyOiRelationship(priceReturn, oiRatePerMinute);
  return {
    score: round(Math.tanh(priceComponent * oiComponent) * 100, 4),
    relationship,
    priceReturn: round(priceReturn, 8),
    oiReturn: round(oiReturn, 8),
    oiRatePerMinute: round(oiRatePerMinute, 8),
  };
}

function calculateRealizedVolatility(state, nowMs) {
  const samples = state.flowSamples.filter(
    (sample) => nowMs - sample.timeMs <= state.config.flowWindowMs,
  );
  if (samples.length < 3) return { realizedBps: 0, ratio: 0, status: 'INSUFFICIENT_DATA' };
  let squaredReturns = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index].price;
    const previous = samples[index - 1].price;
    const logReturn = Math.log(current / previous);
    squaredReturns += logReturn ** 2;
  }
  const realizedBps = Math.sqrt(squaredReturns) * 10_000;
  return {
    realizedBps: round(realizedBps, 8),
    ratio: round(clamp(realizedBps / state.config.volatilityReferenceBps, 0, 3), 8),
    status: realizedBps >= state.config.volatilityReferenceBps ? 'EXPANDING' : 'COMPRESSED',
  };
}

function calculateImpliedCluster(state) {
  if (state.impliedClusters.size === 0 || state.lastPrice <= 0) {
    return { isInferred: false, distanceBps: null, status: 'NO_INFERRED_CLUSTER' };
  }
  let closest = null;
  for (const cluster of state.impliedClusters.values()) {
    const distanceBps = Math.abs(state.lastPrice / cluster.price - 1) * 10_000;
    if (distanceBps > state.config.clusterSearchBps) continue;
    const relevance = cluster.openInterestAdded / Math.max(1, distanceBps);
    if (!closest || relevance > closest.relevance) {
      closest = { ...cluster, distanceBps, relevance };
    }
  }
  if (!closest) return { isInferred: false, distanceBps: null, status: 'NO_NEAR_CLUSTER' };
  return {
    isInferred: true,
    distanceBps: round(closest.distanceBps, 4),
    clusterPrice: round(closest.price, 8),
    openInterestAdded: round(closest.openInterestAdded, 8),
    status: 'INFERRED_OI_BUILD_CLUSTER',
  };
}

function dynamicWeights(base, volatilityRatio) {
  const expansion = Math.exp(Math.min(volatilityRatio, 2));
  const raw = {
    obi: base.obi / Math.sqrt(1 + volatilityRatio),
    lacvd: base.lacvd * expansion,
    vpin: base.vpin * expansion,
    liquidation: base.liquidation * expansion,
    oi: base.oi / (1 + volatilityRatio),
  };
  const total = Object.values(raw).reduce((sum, weight) => sum + weight, 0);
  return Object.fromEntries(Object.entries(raw).map(([key, weight]) => [key, round(weight / total, 8)]));
}

function fuseEvidence(evidence) {
  const transformed = evidence.map(({ value, weight }) => ({
    value: Math.tanh(value / 100),
    weight,
  }));
  const nonlinearEvidence = transformed.reduce(
    (sum, item) => sum + Math.sign(item.value) * Math.expm1(Math.abs(item.value) * item.weight),
    0,
  );
  return round(Math.tanh(nonlinearEvidence * 2.5) * 100, 4);
}

function choosePrimaryTrigger(metrics) {
  if (Math.abs(metrics.lacvd.score) >= 50 && metrics.vpin.value >= 0.7) {
    return 'LACVD_DIVERGENCE_PLUS_VPIN_SPIKE';
  }
  if (metrics.impliedCluster.isInferred) return 'INFERRED_OI_BUILD_CLUSTER_PROXIMITY';
  if (Math.abs(metrics.depthWeightedObi.score) >= 50) return 'DEPTH_WEIGHTED_OBI';
  if (Math.abs(metrics.oi.score) >= 40) return 'OI_DELTA_PRICE_DIVERGENCE';
  return 'MICROSTRUCTURE_MIXED';
}

function chooseSecondaryTrigger(metrics, primary) {
  const candidates = [
    ['LACVD_DIVERGENCE_PLUS_VPIN_SPIKE', Math.abs(metrics.lacvd.score) + metrics.vpin.value * 100],
    ['INFERRED_OI_BUILD_CLUSTER_PROXIMITY', metrics.impliedCluster.isInferred ? 100 : 0],
    ['DEPTH_WEIGHTED_OBI', Math.abs(metrics.depthWeightedObi.score)],
    ['OI_DELTA_PRICE_DIVERGENCE', Math.abs(metrics.oi.score)],
  ].filter(([name]) => name !== primary);
  candidates.sort((left, right) => right[1] - left[1]);
  return candidates[0]?.[0] ?? 'NONE';
}

function classifyOiRelationship(priceReturn, oiRatePerMinute) {
  if (priceReturn > 0 && oiRatePerMinute > 0) return 'NEW_MONEY_LONG';
  if (priceReturn > 0 && oiRatePerMinute < 0) return 'SHORT_COVERING';
  if (priceReturn < 0 && oiRatePerMinute > 0) return 'NEW_MONEY_SHORT';
  if (priceReturn < 0 && oiRatePerMinute < 0) return 'LONG_UNWIND';
  return 'FLAT_OR_UNCLEAR';
}

function updateVpin(state, quantity, isBuy, eventTimeMs) {
  if (state.vpin.targetVolume === 0) {
    const cutoff = eventTimeMs - state.config.flowWindowMs;
    const recentVolume = [...state.flowBuckets.entries()]
      .filter(([timeMs]) => timeMs >= cutoff)
      .reduce((sum, [, bucket]) => sum + bucket.buyQuantity + bucket.sellQuantity, 0);
    state.vpin.targetVolume = recentVolume / state.config.vpinBucketCount;
  }
  if (state.vpin.targetVolume <= 0) return;

  let remaining = quantity;
  while (remaining > 0) {
    if (state.vpin.targetVolume <= 0) {
      const cutoff = eventTimeMs - state.config.flowWindowMs;
      const recentVolume = [...state.flowBuckets.entries()]
        .filter(([timeMs]) => timeMs >= cutoff)
        .reduce((sum, [, bucket]) => sum + bucket.buyQuantity + bucket.sellQuantity, 0);
      state.vpin.targetVolume = recentVolume / state.config.vpinBucketCount;
      if (state.vpin.targetVolume <= 0) break;
    }
    const available = state.vpin.targetVolume - state.vpin.currentVolume;
    const consumed = Math.min(remaining, available);
    if (isBuy) state.vpin.currentBuyVolume += consumed;
    else state.vpin.currentSellVolume += consumed;
    state.vpin.currentVolume += consumed;
    remaining -= consumed;
    if (state.vpin.currentVolume >= state.vpin.targetVolume - 1e-12) {
      const imbalance = Math.abs(state.vpin.currentBuyVolume - state.vpin.currentSellVolume)
        / state.vpin.targetVolume;
      state.vpin.completed.push(clamp(imbalance, 0, 1));
      if (state.vpin.completed.length > state.config.vpinWindowBuckets) {
        state.vpin.completed.shift();
      }
      state.vpin.targetVolume = 0;
      state.vpin.currentVolume = 0;
      state.vpin.currentBuyVolume = 0;
      state.vpin.currentSellVolume = 0;
    }
  }
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
