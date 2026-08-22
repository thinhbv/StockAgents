import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createUniverseRepo } from '../src/repositories/universe.js';
import { createIntradayFlowRepo } from '../src/repositories/intraday_flow.js';

let client, universe, intradayFlow;

before(async () => {
  client = await withTestDb();
  universe = createUniverseRepo(client);
  intradayFlow = createIntradayFlowRepo(client);
});
beforeEach(async () => {
  await resetTables(client, ['intraday_flow_snapshot', 'universe']);
  await universe.upsertMany([
    { symbol: 'HOSE:FPT', exchange: 'HOSE', sector: 'Công nghệ', name: 'FPT' },
    { symbol: 'HOSE:VCB', exchange: 'HOSE', sector: 'Ngân hàng', name: 'Vietcombank' },
  ]);
});
after(async () => { await client.close(); });

test('insertSnapshot lưu payload JSON', async () => {
  const { id } = await intradayFlow.insertSnapshot('HOSE:FPT', { vwapVnd: 71_500 });
  assert.ok(id > 0);
  const { rows } = await client.query('SELECT payload FROM intraday_flow_snapshot WHERE id = $1', [id]);
  assert.equal(rows[0].payload.vwapVnd, 71_500);
});

test('getLatest trả về null khi chưa có snapshot', async () => {
  assert.equal(await intradayFlow.getLatest('HOSE:FPT'), null);
});

test('getLatest lấy đúng bản GẦN ĐÂY NHẤT, không phải bản đầu', async () => {
  await client.query(
    `INSERT INTO intraday_flow_snapshot (symbol, captured_at, payload) VALUES
       ('HOSE:FPT', now() - interval '30 minutes', '{"vwapVnd": 70000}'),
       ('HOSE:FPT', now() - interval '5 minutes',  '{"vwapVnd": 71500}')`);
  const r = await intradayFlow.getLatest('HOSE:FPT');
  assert.equal(r.vwapVnd, 71_500);
});

test('getLatestForSymbols trả về đúng bản mới nhất cho từng mã trong MỘT câu truy vấn', async () => {
  await intradayFlow.insertSnapshot('HOSE:FPT', { vwapVnd: 71_500 });
  await intradayFlow.insertSnapshot('HOSE:VCB', { vwapVnd: 92_000 });

  const map = await intradayFlow.getLatestForSymbols(['HOSE:FPT', 'HOSE:VCB']);
  assert.equal(map.get('HOSE:FPT').vwapVnd, 71_500);
  assert.equal(map.get('HOSE:VCB').vwapVnd, 92_000);
});

test('getLatestForSymbols với mảng rỗng trả về Map rỗng, không lỗi', async () => {
  const map = await intradayFlow.getLatestForSymbols([]);
  assert.equal(map.size, 0);
});

test('getLatestForSymbols không lẫn mã không được hỏi tới', async () => {
  await intradayFlow.insertSnapshot('HOSE:FPT', { vwapVnd: 71_500 });
  await intradayFlow.insertSnapshot('HOSE:VCB', { vwapVnd: 92_000 });

  const map = await intradayFlow.getLatestForSymbols(['HOSE:FPT']);
  assert.equal(map.size, 1);
  assert.equal(map.has('HOSE:VCB'), false);
});
