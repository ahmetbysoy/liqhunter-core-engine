import WebSocket from 'ws';
import {
  calculateDirectionalAnalysis,
  ingestAggTrade,
  ingestDepth,
  ingestLiquidation,
  ingestOpenInterest,
} from './analysis.js';

const REST_URL = process.env.BINANCE_FUTURES_REST_URL ?? 'https://fapi.binance.com';
const WS_URL = process.env.BINANCE_FUTURES_WS_URL ?? 'wss://fstream.binance.com/ws';
const OI_POLL_MS = 3_000;
const OI_TIMEOUT_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class BinanceMicrostructureStreams {
  constructor({ symbol, state, onAnalysis = () => {}, logger = console }) {
    this.symbol = symbol.toLowerCase();
    this.state = state;
    this.onAnalysis = onAnalysis;
    this.logger = logger;
    this.connections = new Map();
    this.oiTimer = null;
    this.oiRequestInFlight = false;
    this.lastAnalysisEmitMs = 0;
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect('aggTrade', `${WS_URL}/${this.symbol}@aggTrade`, (message) => {
      ingestAggTrade(this.state, {
        price: message.p,
        quantity: message.q,
        isBuyerMaker: message.m,
        eventTimeMs: message.T ?? message.E,
      });
      this.emitAnalysis();
    });
    this.connect('depth', `${WS_URL}/${this.symbol}@depth20@100ms`, (message) => {
      ingestDepth(this.state, {
        bids: message.b,
        asks: message.a,
        updateId: message.u,
        eventTimeMs: message.E,
      });
      this.emitAnalysis();
    });
    this.connect('forceOrder', `${WS_URL}/${this.symbol}@forceOrder`, (message) => {
      const order = message.o;
      if (!order) throw new TypeError('forceOrder payload is missing order data');
      ingestLiquidation(this.state, {
        side: order.S,
        price: order.ap || order.p,
        quantity: order.q,
        eventTimeMs: message.E,
      });
      this.emitAnalysis();
    });
    this.pollOpenInterest();
    this.oiTimer = setInterval(() => this.pollOpenInterest(), OI_POLL_MS);
  }

  stop() {
    this.stopped = true;
    if (this.oiTimer) clearInterval(this.oiTimer);
    this.oiTimer = null;
    for (const connection of this.connections.values()) {
      clearTimeout(connection.reconnectTimer);
      connection.ws?.close();
    }
    this.connections.clear();
  }

  connect(id, url, onMessage) {
    const previous = this.connections.get(id);
    if (previous?.ws) previous.ws.close();
    const connection = {
      attempt: previous?.attempt ?? 0,
      reconnectTimer: null,
      ws: null,
    };
    this.connections.set(id, connection);
    const ws = new WebSocket(url, { perMessageDeflate: false });
    connection.ws = ws;

    ws.on('open', () => {
      connection.attempt = 0;
      this.logger.info(`[stream:${id}] connected`);
    });
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        onMessage(message);
      } catch (error) {
        this.state.health.streamErrors += 1;
        this.logger.error(`[stream:${id}] message error`, error);
      }
    });
    ws.on('error', (error) => {
      this.state.health.streamErrors += 1;
      this.logger.error(`[stream:${id}] socket error`, error.message);
    });
    ws.on('close', () => {
      if (this.stopped || this.connections.get(id) !== connection) return;
      const delay = Math.min(1_000 * 2 ** connection.attempt, MAX_RECONNECT_DELAY_MS);
      connection.attempt += 1;
      this.logger.warn(`[stream:${id}] closed; reconnecting in ${delay}ms`);
      connection.reconnectTimer = setTimeout(() => {
        if (!this.stopped) this.connect(id, url, onMessage);
      }, delay);
    });
  }

  async pollOpenInterest() {
    if (this.stopped || this.oiRequestInFlight) return;
    this.oiRequestInFlight = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OI_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${REST_URL}/fapi/v1/openInterest?symbol=${this.symbol.toUpperCase()}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      ingestOpenInterest(this.state, {
        value: payload.openInterest,
        eventTimeMs: Number(payload.time) || Date.now(),
      });
      this.emitAnalysis();
    } catch (error) {
      this.state.health.streamErrors += 1;
      this.logger.error('[open-interest] request error', error.message);
    } finally {
      clearTimeout(timeout);
      this.oiRequestInFlight = false;
    }
  }

  emitAnalysis() {
    const nowMs = Date.now();
    if (nowMs - this.lastAnalysisEmitMs < 100) return;
    this.lastAnalysisEmitMs = nowMs;
    this.onAnalysis(calculateDirectionalAnalysis(this.state, nowMs));
  }
}
