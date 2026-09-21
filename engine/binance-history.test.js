import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceHistoryClient, DataSourceUnavailableError } from './binance-history.js';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
  };
}

test('treats HTTP 451 as a non-retryable data source limit', async () => {
  let calls = 0;
  const client = new BinanceHistoryClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(451, {});
    },
    minDelayMs: 0,
  });

  await assert.rejects(
    () => client.request('/fapi/v1/aggTrades', { symbol: 'BTCUSDT' }),
    (error) => {
      assert.ok(error instanceof DataSourceUnavailableError);
      assert.equal(error.reason, 'geo_blocked');
      return true;
    },
  );
  assert.equal(calls, 1, '451 must not be retried');
});

test('treats HTTP 403 as a blocked egress', async () => {
  const client = new BinanceHistoryClient({
    fetchImpl: async () => jsonResponse(403, {}),
    minDelayMs: 0,
  });
  await assert.rejects(
    () => client.request('/fapi/v1/depth', {}),
    (error) => error instanceof DataSourceUnavailableError && error.reason === 'forbidden',
  );
});

test('returns parsed body on success', async () => {
  const client = new BinanceHistoryClient({
    fetchImpl: async () => jsonResponse(200, [{ a: 1 }]),
    minDelayMs: 0,
  });
  const body = await client.request('/fapi/v1/aggTrades', { symbol: 'BTCUSDT' });
  assert.deepEqual(body, [{ a: 1 }]);
});
