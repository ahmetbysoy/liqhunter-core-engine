import {
  calculateDirectionalAnalysis,
  createState,
  ingestAggTrade,
  ingestDepth,
  ingestLiquidation,
  ingestOpenInterest,
} from './analysis.js';

const EVENT_HANDLERS = Object.freeze({
  aggTrade: ingestAggTrade,
  depth: ingestDepth,
  liquidation: ingestLiquidation,
  openInterest: ingestOpenInterest,
});

export function replayEvents(
  events,
  {
    symbol = 'BTCUSDT',
    config = {},
    horizonMs = 60_000,
    predictionIntervalMs = 1_000,
  } = {},
) {
  if (!Array.isArray(events)) throw new TypeError('replay events must be an array');
  if (!Number.isSafeInteger(horizonMs) || horizonMs <= 0) {
    throw new TypeError('replay horizon must be a positive integer');
  }
  if (!Number.isSafeInteger(predictionIntervalMs) || predictionIntervalMs < 0) {
    throw new TypeError('prediction interval must be a non-negative integer');
  }

  const state = createState(symbol, config);
  const predictions = [];
  const analyses = [];
  let previousTimeMs = 0;
  let lastPredictionTimeMs = 0;

  for (const event of events) {
    const normalized = normalizeEvent(event);
    if (normalized.eventTimeMs < previousTimeMs) {
      throw new RangeError('replay events must be ordered by eventTimeMs');
    }
    previousTimeMs = normalized.eventTimeMs;

    const handler = EVENT_HANDLERS[normalized.type];
    handler(state, normalized.data);
    settlePredictions(predictions, state.lastPrice, normalized.eventTimeMs, horizonMs);

    const analysis = calculateDirectionalAnalysis(state, normalized.eventTimeMs);
    if (analysis.status !== 'READY') continue;
    analyses.push(analysis);
    if (
      lastPredictionTimeMs === 0 ||
      normalized.eventTimeMs - lastPredictionTimeMs >= predictionIntervalMs
    ) {
      predictions.push({
        entryTimeMs: normalized.eventTimeMs,
        entryPrice: state.lastPrice,
        direction: analysis.signal.direction,
        confidenceScore: analysis.signal.confidence_score,
        primaryTrigger: analysis.signal.primary_trigger,
        exitTimeMs: null,
        exitPrice: null,
        rawReturnBps: null,
        signedReturnBps: null,
        correct: null,
      });
      lastPredictionTimeMs = normalized.eventTimeMs;
    }
  }

  return {
    symbol: state.symbol,
    horizonMs,
    predictionIntervalMs,
    processedEvents: events.length,
    analyses,
    predictions,
    summary: summarizePredictions(predictions),
  };
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('replay event must be an object');
  }
  const handler = EVENT_HANDLERS[event.type];
  if (!handler) throw new TypeError(`unsupported replay event type: ${event.type}`);
  const eventTimeMs = Number(event.eventTimeMs ?? event.data?.eventTimeMs);
  if (!Number.isSafeInteger(eventTimeMs) || eventTimeMs <= 0) {
    throw new TypeError('replay event timestamp must be a positive integer');
  }
  if (!event.data || typeof event.data !== 'object') {
    throw new TypeError('replay event data must be an object');
  }
  return {
    type: event.type,
    eventTimeMs,
    data: { ...event.data, eventTimeMs },
  };
}

function settlePredictions(predictions, exitPrice, exitTimeMs, horizonMs) {
  for (const prediction of predictions) {
    if (prediction.exitTimeMs !== null) continue;
    if (exitTimeMs - prediction.entryTimeMs < horizonMs) continue;

    const rawReturnBps = (exitPrice / prediction.entryPrice - 1) * 10_000;
    const signedReturnBps = isLongDirection(prediction.direction)
      ? rawReturnBps
      : isShortDirection(prediction.direction)
        ? -rawReturnBps
        : null;
    prediction.exitTimeMs = exitTimeMs;
    prediction.exitPrice = exitPrice;
    prediction.rawReturnBps = round(rawReturnBps, 8);
    prediction.signedReturnBps = signedReturnBps === null ? null : round(signedReturnBps, 8);
    prediction.correct = signedReturnBps === null || signedReturnBps === 0
      ? null
      : signedReturnBps > 0;
  }
}

function summarizePredictions(predictions) {
  const settled = predictions.filter((prediction) => prediction.exitTimeMs !== null);
  const directional = settled.filter((prediction) => prediction.signedReturnBps !== null);
  const correct = directional.filter((prediction) => prediction.correct).length;
  const averageSignedReturnBps = directional.length === 0
    ? null
    : directional.reduce((sum, prediction) => sum + prediction.signedReturnBps, 0) / directional.length;

  return {
    totalPredictions: predictions.length,
    settledPredictions: settled.length,
    pendingPredictions: predictions.length - settled.length,
    directionalPredictions: directional.length,
    correctPredictions: correct,
    accuracy: directional.length === 0 ? null : round(correct / directional.length, 8),
    averageSignedReturnBps: averageSignedReturnBps === null
      ? null
      : round(averageSignedReturnBps, 8),
    longPredictions: predictions.filter((prediction) => isLongDirection(prediction.direction)).length,
    shortPredictions: predictions.filter((prediction) => isShortDirection(prediction.direction)).length,
    neutralPredictions: predictions.filter((prediction) => prediction.direction === 'NEUTRAL').length,
  };
}

function isLongDirection(direction) {
  return direction === 'LONG_BIAS' || direction === 'AGGRESSIVE_LONG';
}

function isShortDirection(direction) {
  return direction === 'SHORT_BIAS' || direction === 'AGGRESSIVE_SHORT';
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}
