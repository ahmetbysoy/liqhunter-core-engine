import { createState } from './analysis.js';
import { BinanceMicrostructureStreams } from './binance-streams.js';

const symbol = (process.env.SYMBOL ?? 'BTCUSDT').toUpperCase();
if (!['BTCUSDT', 'ETHUSDT'].includes(symbol)) {
  throw new Error('SYMBOL must be BTCUSDT or ETHUSDT');
}

const state = createState(symbol);
const streams = new BinanceMicrostructureStreams({
  symbol,
  state,
  onAnalysis: (analysis) => {
    if (analysis.status === 'READY') {
      process.stdout.write(`${JSON.stringify(analysis)}\n`);
    }
  },
});

streams.start();

function shutdown(signal) {
  process.stderr.write(`[service] ${signal}; stopping streams\n`);
  streams.stop();
  process.exitCode = 0;
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
