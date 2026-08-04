import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createUniverseRepo } from '../src/repositories/universe.js';
import { createMarketRepo } from '../src/repositories/market.js';
import { createOpsRepo } from '../src/repositories/ops.js';

let client, universe, market, ops;

before(async () => {
  client = await withTestDb();
  universe = createUniverseRepo(client);
  market = createMarketRepo(client);
  ops = createOpsRepo(client);
});
beforeEach(async () => {
  await resetTables(client, ['quote_tick', 'indicator_snapshot', 'ohlcv_daily',
                             'ingest_errors', 'session_state', 'universe']);
  await universe.upsertMany([
    { symbol: 'HOSE:FPT', exchange: 'HOSE', sector: 'Công nghệ', name: 'FPT' },
    { symbol: 'HOSE:VCB', exchange: 'HOSE', sector: 'Ngân hàng', name: 'Vietcombank' },
  ]);
});
after(async () => { await client.close(); });

test('upsertMany chèn mã mới và cập nhật mã đã có', async () => {
  const list = await universe.listActive();
  assert.equal(list.length, 2);

  await universe.upsertMany([
    { symbol: 'HOSE:FPT', exchange: 'HOSE', sector: 'CNTT', name: 'FPT Corp' },
  ]);
  const after = await universe.listActive();
  assert.equal(after.length, 2, 'không được tạo thêm hàng trùng');
  assert.equal(after.find(s => s.symbol === 'HOSE:FPT').sector, 'CNTT');
});

test('listActive bỏ qua mã đã tắt', async () => {
  await client.query("UPDATE universe SET active = FALSE WHERE symbol = 'HOSE:VCB'");
  const list = await universe.listActive();
  assert.deepEqual(list.map(s => s.symbol), ['HOSE:FPT']);
});

test('upsertOhlcvBars ghi bars và trả về số dòng', async () => {
  const n = await market.upsertOhlcvBars('HOSE:FPT', [
    { tradeDate: '2026-07-20', open: 100, high: 110, low: 99, close: 108, volume: 1000 },
    { tradeDate: '2026-07-21', open: 108, high: 112, low: 107, close: 111, volume: 1200 },
  ]);
  assert.equal(n, 2);
});

test('upsertOhlcvBars là idempotent — chạy lại cập nhật thay vì lỗi', async () => {
  const bars = [{ tradeDate: '2026-07-20', open: 100, high: 110, low: 99, close: 108, volume: 1000 }];
  await market.upsertOhlcvBars('HOSE:FPT', bars);
  await market.upsertOhlcvBars('HOSE:FPT', [{ ...bars[0], close: 109, volume: 2000 }]);

  const { rows } = await client.query(
    "SELECT close, volume FROM ohlcv_daily WHERE symbol = 'HOSE:FPT'");
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].close), 109);
  assert.equal(Number(rows[0].volume), 2000);
});

test('upsertOhlcvBars với mảng rỗng trả về 0 và không lỗi', async () => {
  assert.equal(await market.upsertOhlcvBars('HOSE:FPT', []), 0);
});

test('getLatestBar trả về bar mới nhất với số dạng number', async () => {
  await market.upsertOhlcvBars('HOSE:FPT', [
    { tradeDate: '2026-07-20', open: 100, high: 110, low: 99, close: 108, volume: 1000 },
    { tradeDate: '2026-07-21', open: 108, high: 112, low: 107, close: 111, volume: 1200 },
  ]);
  const bar = await market.getLatestBar('HOSE:FPT');
  assert.equal(bar.tradeDate, '2026-07-21');
  assert.equal(bar.close, 111);
  assert.equal(typeof bar.close, 'number');
});

test('getLatestBar trả về null khi chưa có dữ liệu', async () => {
  assert.equal(await market.getLatestBar('HOSE:VCB'), null);
});

test('getLatestBar trả về đúng tradeDate như đã ghi (chống lệch múi giờ)', async () => {
  // Hồi quy cho lỗi: node-pg mặc định parse DATE thành Date object dựng từ
  // giờ ĐỊA PHƯƠNG; quy đổi ẩu qua .toISOString() (UTC) làm lùi ngày một hôm
  // trên các máy có múi giờ dương (vd Asia/Ho_Chi_Minh, UTC+7). Test này chỉ
  // thất bại trên máy không phải UTC nếu type parser DATE trong client.js bị
  // gỡ hoặc hỏng — assertion phải là so khớp chuỗi CHÍNH XÁC, không phải sai
  // số cho phép.
  await market.upsertOhlcvBars('HOSE:FPT', [
    { tradeDate: '2026-07-21', open: 100, high: 110, low: 99, close: 108, volume: 1000 },
  ]);
  const bar = await market.getLatestBar('HOSE:FPT');
  assert.equal(bar.tradeDate, '2026-07-21');
});

test('insertIndicatorSnapshot lưu payload JSON', async () => {
  const { id } = await market.insertIndicatorSnapshot('HOSE:FPT', { rsi14: 62.5, ma20: 105 });
  assert.ok(id > 0);
  const { rows } = await client.query('SELECT payload FROM indicator_snapshot WHERE id = $1', [id]);
  assert.equal(rows[0].payload.rsi14, 62.5);
});

test('getLatestIndicatorAgeMinutes trả về null khi chưa có snapshot', async () => {
  assert.equal(await market.getLatestIndicatorAgeMinutes(), null);
});

test('getLatestIndicatorAgeMinutes trả về null khi CÒN mã chưa từng có snapshot', async () => {
  // Hồi quy: bản cũ dùng MAX toàn cục nên chỉ cần MỘT mã tươi là nó báo
  // "30 phút", che mất việc VCB chưa từng được ingest. Cổng an toàn PRE_OPEN
  // sẽ mở phiên trên dữ liệu không tồn tại.
  await client.query(
    `INSERT INTO indicator_snapshot (symbol, captured_at, payload)
     VALUES ('HOSE:FPT', now() - interval '30 minutes', '{}')`);

  assert.equal(
    await market.getLatestIndicatorAgeMinutes(), null,
    'HOSE:VCB chưa có snapshot nào → độ tươi phải là không xác định',
  );
});

test('getLatestIndicatorAgeMinutes lấy tuổi của mã CŨ NHẤT, không phải mới nhất', async () => {
  await client.query(
    `INSERT INTO indicator_snapshot (symbol, captured_at, payload) VALUES
       ('HOSE:FPT', now() - interval '5 minutes',  '{}'),
       ('HOSE:VCB', now() - interval '90 minutes', '{}')`);

  const age = await market.getLatestIndicatorAgeMinutes();
  assert.ok(age >= 89 && age <= 91, `kỳ vọng ~90 (mã cũ nhất), nhận ${age}`);
});

test('getLatestIndicatorAgeMinutes bỏ qua mã đã tắt', async () => {
  await client.query("UPDATE universe SET active = FALSE WHERE symbol = 'HOSE:VCB'");
  await client.query(
    `INSERT INTO indicator_snapshot (symbol, captured_at, payload)
     VALUES ('HOSE:FPT', now() - interval '10 minutes', '{}')`);

  const age = await market.getLatestIndicatorAgeMinutes();
  assert.ok(age >= 9 && age <= 11, `kỳ vọng ~10, nhận ${age}`);
});

test('getLatestIndicatorAgeMinutes dùng snapshot MỚI NHẤT của mỗi mã', async () => {
  // indicator_snapshot là append-only: mỗi lần ingest thêm một hàng.
  // Độ tươi của một mã là hàng gần nhất của nó, không phải hàng đầu tiên.
  await client.query(
    `INSERT INTO indicator_snapshot (symbol, captured_at, payload) VALUES
       ('HOSE:FPT', now() - interval '300 minutes', '{}'),
       ('HOSE:FPT', now() - interval '20 minutes',  '{}'),
       ('HOSE:VCB', now() - interval '25 minutes',  '{}')`);

  const age = await market.getLatestIndicatorAgeMinutes();
  assert.ok(age >= 24 && age <= 26, `kỳ vọng ~25, nhận ${age}`);
});

test('insertQuoteTicks ghi nhiều tick trong một lần', async () => {
  const n = await market.insertQuoteTicks([
    { symbol: 'HOSE:FPT', price: 111.5, volume: 500 },
    { symbol: 'HOSE:VCB', price: 92.0, volume: 300 },
  ]);
  assert.equal(n, 2);
});

test('setSessionState ghi mới rồi ghi đè cùng ngày', async () => {
  await ops.setSessionState('2026-07-21', 'PRE_OPEN', {});
  await ops.setSessionState('2026-07-21', 'OPEN', { note: 'đã ingest xong' });

  const state = await ops.getSessionState('2026-07-21');
  assert.equal(state.state, 'OPEN');
  assert.equal(state.note, 'đã ingest xong');
});

test('logIngestError lưu lỗi và đếm được', async () => {
  await ops.logIngestError('ingest_prices', 'HOSE:FPT', 'chart chưa sẵn sàng');
  await ops.logIngestError('ingest_prices', null, 'CDP đứt kết nối');
  const n = await ops.countIngestErrorsSince(new Date(Date.now() - 60_000));
  assert.equal(n, 2);
});
