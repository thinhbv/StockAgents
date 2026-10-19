import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createOrchestrator } from '../src/orchestrator/session.js';
import { createStubProvider } from '../src/llm/stub.js';

const silent = { info() {}, warn() {}, error() {} };
let client;

before(async () => { client = await withTestDb(); });
beforeEach(async () => {
  await resetTables(client, ['quote_tick', 'ohlcv_daily', 'universe']);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
});
after(async () => { await client.close(); });

test('giá tham chiếu lấy từ ohlcv_daily khi có, không dùng giá VCI', async () => {
  await client.query(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
    VALUES ('HOSE:FPT','2026-10-16', 99000, 101000, 98000, 100000, 1000000)`);
  await client.query(`INSERT INTO quote_tick (symbol, price, volume, ref_price)
    VALUES ('HOSE:FPT', 100500, 5000, 98000)`);

  const orch = createOrchestrator({ client, logger: silent });
  const { refPriceMap } = await orch.buildWatchContext(createStubProvider({ script: [] }));
  assert.equal(refPriceMap.get('HOSE:FPT'), 100000);
});

test('thiếu ohlcv_daily thì dùng giá tham chiếu VCI của tick có giá đó, bỏ qua tick mới không có', async () => {
  await client.query(`INSERT INTO quote_tick (symbol, price, volume, ref_price, ts) VALUES
    ('HOSE:FPT', 97000, 5000, 98000, now() - interval '1 hour'),
    ('HOSE:FPT', 100500, 5000, NULL, now())`);

  const orch = createOrchestrator({ client, logger: silent });
  const { refPriceMap } = await orch.buildWatchContext(createStubProvider({ script: [] }));
  assert.equal(refPriceMap.get('HOSE:FPT'), 98000);
});
