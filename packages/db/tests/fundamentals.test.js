import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createUniverseRepo } from '../src/repositories/universe.js';
import { createFundamentalsRepo } from '../src/repositories/fundamentals.js';

let client, universe, fundamentals;

before(async () => {
  client = await withTestDb();
  universe = createUniverseRepo(client);
  fundamentals = createFundamentalsRepo(client);
});
beforeEach(async () => {
  await resetTables(client, ['fundamentals_snapshot', 'universe']);
  await universe.upsertMany([
    { symbol: 'HOSE:FPT', exchange: 'HOSE', sector: 'Công nghệ', name: 'FPT' },
    { symbol: 'HOSE:VCB', exchange: 'HOSE', sector: 'Ngân hàng', name: 'Vietcombank' },
  ]);
});
after(async () => { await client.close(); });

test('insertSnapshot lưu payload JSON', async () => {
  const { id } = await fundamentals.insertSnapshot('HOSE:FPT', { pe: 11.6, roe: 0.26 });
  assert.ok(id > 0);
  const { rows } = await client.query('SELECT payload FROM fundamentals_snapshot WHERE id = $1', [id]);
  assert.equal(rows[0].payload.pe, 11.6);
});

test('getLatest trả về null khi chưa có snapshot', async () => {
  assert.equal(await fundamentals.getLatest('HOSE:FPT'), null);
});

test('getLatest lấy đúng bản GẦN ĐÂY NHẤT, không phải bản đầu', async () => {
  await client.query(
    `INSERT INTO fundamentals_snapshot (symbol, captured_at, payload) VALUES
       ('HOSE:FPT', now() - interval '90 days', '{"pe": 20}'),
       ('HOSE:FPT', now() - interval '1 day',   '{"pe": 11.6}')`);
  const r = await fundamentals.getLatest('HOSE:FPT');
  assert.equal(r.pe, 11.6);
});

test('getLatestForSymbols trả về đúng bản mới nhất cho từng mã trong MỘT câu truy vấn', async () => {
  await fundamentals.insertSnapshot('HOSE:FPT', { pe: 11.6 });
  await fundamentals.insertSnapshot('HOSE:VCB', { pe: 8.2 });

  const map = await fundamentals.getLatestForSymbols(['HOSE:FPT', 'HOSE:VCB']);
  assert.equal(map.get('HOSE:FPT').pe, 11.6);
  assert.equal(map.get('HOSE:VCB').pe, 8.2);
});

test('getLatestForSymbols với mảng rỗng trả về Map rỗng, không lỗi', async () => {
  const map = await fundamentals.getLatestForSymbols([]);
  assert.equal(map.size, 0);
});

test('getLatestForSymbols không lẫn mã không được hỏi tới', async () => {
  await fundamentals.insertSnapshot('HOSE:FPT', { pe: 11.6 });
  await fundamentals.insertSnapshot('HOSE:VCB', { pe: 8.2 });

  const map = await fundamentals.getLatestForSymbols(['HOSE:FPT']);
  assert.equal(map.size, 1);
  assert.equal(map.has('HOSE:VCB'), false);
});
