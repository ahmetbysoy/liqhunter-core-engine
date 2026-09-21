export const DEFAULT_METRIC_CONFIG = Object.freeze({
  cvdWindowMs: 300_000,
  cvdMinSamples: 30,
  obiLevels: 10,
  microSmoothingMs: 5_000,
  layerThresholdsUsd: Object.freeze([1_000, 10_000, 100_000, 1_000_000]),
  spoofMinNotionalUsd: 250_000,
  spoofShrinkFraction: 0.68,
  spoofLifetimeMs: 8_000,
  spoofDistanceBps: 60,
  absorptionBucketMs: 10_000,
  absorptionVolumeMultiplier: 2.2,
  absorptionMaxMoveBps: 3.5,
  cascadeWindowMs: 5_000,
  cascadeMinNotionalUsd: 100_000,
  cascadeMinEvents: 2,
});

const LAYER_NAMES = Object.freeze(['RETAIL', 'MID', 'LARGE', 'WHALE', 'KRAKEN']);

export function createMetricState(symbol, config = {}) {
  return {
    symbol: symbol.toUpperCase(),
    config: {
      ...DEFAULT_METRIC_CONFIG,
      ...config,
      layerThresholdsUsd: [...(config.layerThresholdsUsd ?? DEFAULT_METRIC_CONFIG.layerThresholdsUsd)],
    },
    trades: [],
    bestBid: 0,
    bestAsk: 0,
    bids: [],
    asks: [],
    lastTradePrice: 0,
    lastTradeTimeMs: 0,
    lastDepthTimeMs: 0,
    depthUpdateId: 0,
    liquidations: [],
    spoofWalls: new Map(),
    spoofEvents: [],
    absorptionBuckets: [],
    lastAbsorptionCheckMs: 0,
    absorptionWindowStartMs: 0,
    absorptionVolumeUsd: 0,
    absorptionDeltaUsd: 0,
    absorptionOpenPrice: 0,
    absorptionLastPrice: 0,
    rejection: {
      futureTrades: 0,
      staleTrades: 0,
      duplicateDepth: 0,
    },
  };
}

export function ingestTrade(state, trade, nowMs = Date.now()) {
  const price = positiveNumber(trade.price, 'trade price');
  const quantity = positiveNumber(trade.quantity, 'trade quantity');
  const eventTimeMs = safeTimestamp(trade.eventTimeMs ?? nowMs);

  if (eventTimeMs > nowMs + state.config.spoofLifetimeMs) {
    state.rejection.futureTrades += 1;
    return;
  }
  if (nowMs - eventTimeMs > state.config.cvdWindowMs * 4) {
    state.rejection.staleTrades += 1;
    return;
  }

  const isBuyerMaker = Boolean(trade.isBuyerMaker);
  const signedUsd = isBuyerMaker ? -(price * quantity) : price * quantity;

  state.trades.push({ eventTimeMs, price, quantity, signedUsd, isBuyerMaker });
  state.lastTradePrice = price;
  state.lastTradeTimeMs = eventTimeMs;
  trackAbsorption(state, price, quantity, signedUsd, eventTimeMs);
  pruneTrades(state, nowMs);
}

export function ingestDepth(state, depth, nowMs = Date.now()) {
  const updateId = Number(depth.updateId);
  if (!Number.isSafeInteger(updateId) || updateId <= 0) {
    throw new TypeError('depth update id must be a positive integer');
  }
  const eventTimeMs = safeTimestamp(depth.eventTimeMs ?? nowMs);
  if (state.depthUpdateId > 0 && updateId <= state.depthUpdateId) {
    state.rejection.duplicateDepth += 1;
    return false;
  }

  const bids = normalizeLevels(depth.bids);
  const asks = normalizeLevels(depth.asks);
  if (bids.length === 0 || asks.length === 0) {
    throw new TypeError('depth snapshot must contain bids and asks');
  }

  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) {
    throw new TypeError('depth snapshot has an invalid spread');
  }

  updateSpoofTracking(state, bids, asks, bestBid, bestAsk, eventTimeMs);

  state.bids = bids;
  state.asks = asks;
  state.bestBid = bestBid;
  state.bestAsk = bestAsk;
  state.depthUpdateId = updateId;
  state.lastDepthTimeMs = eventTimeMs;
  return true;
}

export function ingestLiquidation(state, liquidation, nowMs = Date.now()) {
  const side = liquidation.side;
  if (side !== 'BUY' && side !== 'SELL') {
    throw new TypeError('liquidation side must be BUY or SELL');
  }
  const price = positiveNumber(liquidation.price, 'liquidation price');
  const quantity = positiveNumber(liquidation.quantity, 'liquidation quantity');
  const eventTimeMs = safeTimestamp(liquidation.eventTimeMs ?? nowMs);
  state.liquidations.push({ side, price, quantity, notionalUsd: price * quantity, eventTimeMs });
  state.liquidations = state.liquidations.filter(
    (event) => nowMs - event.eventTimeMs <= state.config.cascadeWindowMs * 6,
  );
}

export function computeMetrics(state, nowMs = Date.now()) {
  const flow = computeFlow(state, nowMs);
  return {
    symbol: state.symbol,
    timestampMs: nowMs,
    price: state.lastTradePrice,
    flow,
    obi: computeDepthWeightedObi(state),
    microprice: computeMicroprice(state),
    cvd: computeCvdZScore(state, nowMs),
    layers: computeLayerImbalance(state, nowMs),
    spoof: summarizeSpoof(state, nowMs),
    absorption: summarizeAbsorption(state, nowMs),
    cascade: summarizeCascade(state, nowMs),
  };
}

function computeFlow(state, nowMs) {
  const window = state.trades.filter((trade) => nowMs - trade.eventTimeMs <= state.config.cvdWindowMs);
  let buyUsd = 0;
  let sellUsd = 0;
  for (const trade of window) {
    if (trade.isBuyerMaker) sellUsd += trade.price * trade.quantity;
    else buyUsd += trade.price * trade.quantity;
  }
  const total = buyUsd + sellUsd;
  return {
    sampleCount: window.length,
    buyUsd,
    sellUsd,
    totalUsd: total,
    imbalance: total > 0 ? (buyUsd - sellUsd) / total : 0,
  };
}

function computeDepthWeightedObi(state) {
  if (state.bestBid <= 0 || state.bestAsk <= 0) {
    return { value: 0, bidWeighted: 0, askWeighted: 0, levelsUsed: 0 };
  }
  const mid = (state.bestBid + state.bestAsk) / 2;
  const levels = Math.min(state.config.obiLevels, state.bids.length, state.asks.length);
  let bidWeighted = 0;
  let askWeighted = 0;

  for (let index = 0; index < levels; index += 1) {
    const [bidPrice, bidQuantity] = state.bids[index];
    const [askPrice, askQuantity] = state.asks[index];
    const bidDistance = Math.max(Math.abs(mid - bidPrice) / mid, 1e-9);
    const askDistance = Math.max(Math.abs(askPrice - mid) / mid, 1e-9);
    bidWeighted += bidQuantity / bidDistance;
    askWeighted += askQuantity / askDistance;
  }

  const total = bidWeighted + askWeighted;
  return {
    value: total > 0 ? (bidWeighted - askWeighted) / total : 0,
    bidWeighted,
    askWeighted,
    levelsUsed: levels,
  };
}

function computeMicroprice(state) {
  if (state.bestBid <= 0 || state.bestAsk <= 0) {
    return { value: 0, mid: 0, deviationBps: 0 };
  }
  const bidSize = state.bids[0]?.[1] ?? 0;
  const askSize = state.asks[0]?.[1] ?? 0;
  const denominator = bidSize + askSize;
  const mid = (state.bestBid + state.bestAsk) / 2;
  const microprice = denominator > 0
    ? (state.bestAsk * bidSize + state.bestBid * askSize) / denominator
    : mid;
  const deviationBps = mid > 0 ? ((microprice - mid) / mid) * 10_000 : 0;
  return { value: microprice, mid, deviationBps };
}

function computeCvdZScore(state, nowMs) {
  const window = state.trades.filter((trade) => nowMs - trade.eventTimeMs <= state.config.cvdWindowMs);
  if (window.length < state.config.cvdMinSamples) {
    return { value: 0, zScore: 0, mean: 0, std: 0, status: 'INSUFFICIENT_DATA' };
  }

  const perSecond = new Map();
  for (const trade of window) {
    const second = Math.floor(trade.eventTimeMs / 1_000);
    perSecond.set(second, (perSecond.get(second) ?? 0) + trade.signedUsd);
  }

  const deltas = [...perSecond.values()];
  if (deltas.length < 2) {
    return { value: 0, zScore: 0, mean: 0, std: 0, status: 'INSUFFICIENT_DATA' };
  }

  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const variance = deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (deltas.length - 1);
  const std = Math.sqrt(variance);
  const cumulative = deltas.reduce((sum, value) => sum + value, 0);
  const zScore = std > 0 ? (cumulative - mean) / std : 0;

  return {
    value: cumulative,
    zScore,
    mean,
    std,
    secondsObserved: deltas.length,
    status: 'READY',
  };
}

function computeLayerImbalance(state, nowMs) {
  const window = state.trades.filter((trade) => nowMs - trade.eventTimeMs <= state.config.cvdWindowMs);
  const thresholds = state.config.layerThresholdsUsd;
  const layerIndex = (notionalUsd) => {
    let index = 0;
    while (index < thresholds.length && notionalUsd >= thresholds[index]) index += 1;
    return Math.min(index, LAYER_NAMES.length - 1);
  };

  const buckets = LAYER_NAMES.map(() => ({ buyUsd: 0, sellUsd: 0, count: 0 }));
  for (const trade of window) {
    const notionalUsd = trade.price * trade.quantity;
    const bucket = buckets[layerIndex(notionalUsd)];
    bucket.count += 1;
    if (trade.isBuyerMaker) bucket.sellUsd += notionalUsd;
    else bucket.buyUsd += notionalUsd;
  }

  const layers = buckets.map((bucket, index) => {
    const total = bucket.buyUsd + bucket.sellUsd;
    return {
      name: LAYER_NAMES[index],
      count: bucket.count,
      buyUsd: bucket.buyUsd,
      sellUsd: bucket.sellUsd,
      imbalance: total > 0 ? (bucket.buyUsd - bucket.sellUsd) / total : 0,
    };
  });

  const retail = ratio(layers[0]);
  const whaleBuy = layers[2].buyUsd + layers[3].buyUsd + layers[4].buyUsd;
  const whaleSell = layers[2].sellUsd + layers[3].sellUsd + layers[4].sellUsd;
  const whaleTotal = whaleBuy + whaleSell;
  const whaleImbalance = whaleTotal > 0 ? (whaleBuy - whaleSell) / whaleTotal : 0;

  return {
    layers,
    retailImbalance: retail,
    whaleImbalance,
    divergence: whaleImbalance - retail,
  };
}

function updateSpoofTracking(state, bids, asks, bestBid, bestAsk, eventTimeMs) {
  const mid = (bestBid + bestAsk) / 2;
  const tracked = new Map();
  const consider = (levels, side) => {
    for (const [price, quantity] of levels.slice(0, 50)) {
      const notionalUsd = price * quantity;
      if (notionalUsd < state.config.spoofMinNotionalUsd) continue;
      const distanceBps = (Math.abs(price - mid) / mid) * 10_000;
      if (distanceBps > state.config.spoofDistanceBps) continue;
      const key = `${side}:${price.toFixed(8)}`;
      tracked.set(key, { side, price, notionalUsd, distanceBps });
    }
  };
  consider(bids, 'BID');
  consider(asks, 'ASK');

  for (const [key, wall] of [...state.spoofWalls]) {
    const current = tracked.get(key);
    const remainingNotional = current ? current.notionalUsd : 0;
    const shrink = wall.notionalUsd > 0 ? 1 - remainingNotional / wall.notionalUsd : 0;
    const lifetime = eventTimeMs - wall.firstSeenMs;
    const isShrunk = shrink >= state.config.spoofShrinkFraction;
    const withinLifetime = lifetime <= state.config.spoofLifetimeMs;

    if (current && (!isShrunk || !withinLifetime)) {
      wall.notionalUsd = Math.max(wall.notionalUsd, current.notionalUsd);
      wall.lastSeenMs = eventTimeMs;
      continue;
    }

    if (isShrunk && withinLifetime) {
      state.spoofEvents.push({
        side: wall.side,
        price: wall.price,
        distanceBps: current ? current.distanceBps : wall.distanceBps,
        peakNotionalUsd: wall.notionalUsd,
        finalNotionalUsd: remainingNotional,
        shrink: Math.min(shrink, 1),
        lifetimeMs: lifetime,
        detectedAtMs: eventTimeMs,
      });
    }
    state.spoofWalls.delete(key);
  }

  for (const [key, wall] of tracked) {
    if (!state.spoofWalls.has(key)) {
      state.spoofWalls.set(key, { ...wall, firstSeenMs: eventTimeMs, lastSeenMs: eventTimeMs });
    }
  }
}

function trackAbsorption(state, price, quantity, signedUsd, eventTimeMs) {
  const bucketStartMs = Math.floor(eventTimeMs / state.config.absorptionBucketMs) * state.config.absorptionBucketMs;
  if (state.absorptionWindowStartMs !== bucketStartMs) {
    finalizeAbsorptionBucket(state);
    state.absorptionWindowStartMs = bucketStartMs;
    state.absorptionVolumeUsd = 0;
    state.absorptionDeltaUsd = 0;
    state.absorptionOpenPrice = price;
  }
  state.absorptionVolumeUsd += price * quantity;
  state.absorptionDeltaUsd += signedUsd;
  state.absorptionLastPrice = price;
}

function finalizeAbsorptionBucket(state) {
  if (state.absorptionWindowStartMs === 0 || state.absorptionVolumeUsd === 0) return;
  const moveBps = state.absorptionOpenPrice > 0
    ? Math.abs(state.absorptionLastPrice / state.absorptionOpenPrice - 1) * 10_000
    : 0;
  state.absorptionBuckets.push({
    startMs: state.absorptionWindowStartMs,
    volumeUsd: state.absorptionVolumeUsd,
    deltaUsd: state.absorptionDeltaUsd,
    moveBps,
  });
  if (state.absorptionBuckets.length > 360) state.absorptionBuckets.shift();
}

function summarizeAbsorption(state, nowMs) {
  const buckets = state.absorptionBuckets.filter(
    (bucket) => nowMs - bucket.startMs <= state.config.cvdWindowMs,
  );
  if (buckets.length < 3) {
    return { detected: false, status: 'INSUFFICIENT_DATA', volumeUsd: 0, moveBps: 0 };
  }

  const volumeSeries = buckets.map((bucket) => Math.abs(bucket.deltaUsd));
  const meanVolume = volumeSeries.reduce((sum, value) => sum + value, 0) / volumeSeries.length;
  let strongest = null;

  for (const bucket of buckets) {
    const magnitude = Math.abs(bucket.deltaUsd);
    if (meanVolume <= 0 || magnitude < meanVolume * state.config.absorptionVolumeMultiplier) continue;
    if (bucket.moveBps > state.config.absorptionMaxMoveBps) continue;
    if (!strongest || magnitude > Math.abs(strongest.deltaUsd)) strongest = bucket;
  }

  if (!strongest) {
    return { detected: false, status: 'NO_ABSORPTION', volumeUsd: 0, moveBps: 0 };
  }

  return {
    detected: true,
    status: 'ABSORPTION_DETECTED',
    side: strongest.deltaUsd > 0 ? 'SELLERS_ABSORBING' : 'BUYERS_ABSORBING',
    volumeUsd: strongest.volumeUsd,
    deltaUsd: strongest.deltaUsd,
    moveBps: strongest.moveBps,
    startMs: strongest.startMs,
  };
}

function summarizeSpoof(state, nowMs) {
  const recent = state.spoofEvents.filter(
    (event) => nowMs - event.detectedAtMs <= state.config.cvdWindowMs,
  );
  state.spoofEvents = recent;
  return {
    detected: recent.length > 0,
    count: recent.length,
    last: recent.at(-1) ?? null,
  };
}

function summarizeCascade(state, nowMs) {
  const recent = state.liquidations.filter(
    (event) => nowMs - event.eventTimeMs <= state.config.cascadeWindowMs,
  );
  let buyNotionalUsd = 0;
  let sellNotionalUsd = 0;
  for (const event of recent) {
    if (event.side === 'BUY') buyNotionalUsd += event.notionalUsd;
    else sellNotionalUsd += event.notionalUsd;
  }
  const dominantSide = buyNotionalUsd >= sellNotionalUsd ? 'BUY' : 'SELL';
  const dominantNotional = Math.max(buyNotionalUsd, sellNotionalUsd);
  const eventCount = recent.length;
  const detected = eventCount >= state.config.cascadeMinEvents
    && dominantNotional >= state.config.cascadeMinNotionalUsd;

  return {
    detected,
    eventCount,
    buyNotionalUsd,
    sellNotionalUsd,
    dominantSide,
    dominantNotionalUsd: dominantNotional,
  };
}

function pruneTrades(state, nowMs) {
  const cutoff = nowMs - state.config.cvdWindowMs;
  state.trades = state.trades.filter((trade) => trade.eventTimeMs >= cutoff);
}

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) throw new TypeError('depth levels must be an array');
  const normalized = levels.map((level) => {
    if (!Array.isArray(level) || level.length < 2) throw new TypeError('invalid depth level');
    return [positiveNumber(level[0], 'depth price'), positiveNumber(level[1], 'depth quantity')];
  });
  normalized.sort((left, right) => right[0] - left[0]);
  return normalized;
}

function ratio(layer) {
  const total = layer.buyUsd + layer.sellUsd;
  return total > 0 ? (layer.buyUsd - layer.sellUsd) / total : 0;
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return number;
}

function safeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError('event timestamp must be a positive integer');
  }
  return timestamp;
}
