const FUTURES_REST = 'https://fapi.binance.com';

export const ONE_MINUTE_MS = 60_000;

export class BinanceHistoryClient {
  constructor({ baseUrl = FUTURES_REST, fetchImpl = fetch, maxRetries = 3, minDelayMs = 120 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.maxRetries = maxRetries;
    this.minDelayMs = minDelayMs;
    this.lastRequestAt = 0;
  }

  async request(path, params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      query.set(key, String(value));
    }
    const url = `${this.baseUrl}${path}${query.size > 0 ? `?${query}` : ''}`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.throttle();
      const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
      if (response.status === 429 || response.status === 418) {
        const retryAfterMs = Number(response.headers?.get?.('retry-after') ?? 0) * 1_000;
        const backoffMs = Math.max(retryAfterMs, 1_000 * 2 ** attempt);
        await sleep(backoffMs);
        continue;
      }
      if (response.status >= 500) {
        if (attempt === this.maxRetries) {
          throw new Error(`HTTP ${response.status} for ${url}`);
        }
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return response.json();
    }
    throw new Error(`retries exhausted for ${url}`);
  }

  async throttle() {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minDelayMs) {
      await sleep(this.minDelayMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  async fetchAggTrades({ symbol, startTimeMs, endTimeMs, pageSize = 1_000, maxPages = 5_000 }) {
    const trades = [];
    let cursor = startTimeMs;
    let pages = 0;

    while (cursor < endTimeMs && pages < maxPages) {
      const page = await this.request('/fapi/v1/aggTrades', {
        symbol,
        startTime: cursor,
        endTime: endTimeMs,
        limit: Math.min(1_000, pageSize),
      });
      if (!Array.isArray(page) || page.length === 0) break;

      for (const row of page) {
        trades.push({
          price: Number(row.p),
          quantity: Number(row.q),
          eventTimeMs: Number(row.T),
          isBuyerMaker: Boolean(row.m),
          aggTradeId: Number(row.a),
        });
      }

      const last = page[page.length - 1];
      const nextCursor = Number(last.T) + 1;
      pages += 1;
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
      if (page.length < 1_000) break;
    }

    return dedupeByAggTradeId(trades).sort((left, right) => left.eventTimeMs - right.eventTimeMs);
  }

  async fetchOneMinuteKlines({ symbol, startTimeMs, endTimeMs }) {
    const klines = [];
    let cursor = startTimeMs;
    let pages = 0;

    while (cursor < endTimeMs && pages < 5_000) {
      const page = await this.request('/fapi/v1/klines', {
        symbol,
        interval: '1m',
        startTime: cursor,
        endTime: endTimeMs,
        limit: 1_500,
      });
      if (!Array.isArray(page) || page.length === 0) break;

      for (const row of page) {
        klines.push({
          openTimeMs: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
          closeTimeMs: Number(row[6]),
        });
      }

      const lastOpen = Number(page[page.length - 1][0]);
      const nextCursor = lastOpen + ONE_MINUTE_MS;
      pages += 1;
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
      if (page.length < 1_500) break;
    }

    const seen = new Set();
    return klines
      .filter((candle) => {
        if (seen.has(candle.openTimeMs)) return false;
        seen.add(candle.openTimeMs);
        return true;
      })
      .sort((left, right) => left.openTimeMs - right.openTimeMs);
  }

  async fetchOpenInterestHistory({ symbol, period = '5m', startTimeMs, endTimeMs, limit = 500 }) {
    const rows = await this.request('/futures/data/openInterestHist', {
      symbol,
      period,
      startTime: startTimeMs,
      endTime: endTimeMs,
      limit,
    });
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => ({
        timeMs: Number(row.timestamp),
        sumOpenInterest: Number(row.sumOpenInterest),
        sumOpenInterestValue: Number(row.sumOpenInterestValue),
      }))
      .sort((left, right) => left.timeMs - right.timeMs);
  }

  async fetchForceOrders({ symbol, startTimeMs, endTimeMs }) {
    const rows = await this.request('/fapi/v1/allForceOrders', {
      symbol,
      startTime: startTimeMs,
      endTime: endTimeMs,
      limit: 100,
    });
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => ({
        side: row.side,
        price: Number(row.averagePrice ?? row.price),
        quantity: Number(row.origQty ?? row.quantity),
        eventTimeMs: Number(row.time),
      }))
      .sort((left, right) => left.eventTimeMs - right.eventTimeMs);
  }
}

function dedupeByAggTradeId(trades) {
  const seen = new Set();
  const result = [];
  for (const trade of trades) {
    if (seen.has(trade.aggTradeId)) continue;
    seen.add(trade.aggTradeId);
    result.push(trade);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
