import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createFakeCore } from '../../../tests/helpers/fake_core.js';
import { createBroker } from '../src/cdp/broker.js';
import { runIngestPrices } from '../src/jobs/ingest_prices.js';
import { runPollQuotes } from '../src/jobs/poll_quotes.js';
import { runPruneEvents } from '../src/jobs/prune_events.js';
import {
  createUniverseRepo, createMarketRepo, createOpsRepo, createEventsRepo,
} from '@stockagents/db';

const silent = { info() {}, warn() {}, error() {} };
const noSleep = () => Promise.resolve();

let client, repos;

before(async () => {
  client = await withTestDb();
  repos = {
    universe: createUniverseRepo(client),
    market: createMarketRepo(client),
    ops: createOpsRepo(client),
    events: createEventsRepo(client),
  };
});
beforeEach(async () => {
  // market_holidays PHẢI nằm trong danh sách xoá: một ngày lễ do test này
  // chèn mà còn sót lại sẽ làm test "ghi tick trong giờ giao dịch" hỏng ở
  // LẦN CHẠY SAU, và lỗi đó trông như không liên quan gì tới đây.
  await resetTables(client, ['quote_tick', 'indicator_snapshot', 'ohlcv_daily',
                             'ingest_errors', 'session_state', 'event_log',
                             'market_holidays', 'universe']);
  await repos.universe.upsertMany([
    { symbol: 'HOSE:FPT', exchange: 'HOSE', name: 'FPT' },
    { symbol: 'HOSE:VCB', exchange: 'HOSE', name: 'Vietcombank' },
  ]);
});
after(async () => { await client.close(); });

test('runIngestPrices ghi bars và indicator snapshot cho mọi mã', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });

  const summary = await runIngestPrices({ broker, repos, logger: silent });

  assert.equal(summary.total, 2);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.failedSymbols, []);

  const bars = await client.query('SELECT COUNT(*)::int AS n FROM ohlcv_daily');
  assert.equal(bars.rows[0].n, 120); // 2 mã × 60 bar

  const snaps = await client.query('SELECT COUNT(*)::int AS n FROM indicator_snapshot');
  assert.equal(snaps.rows[0].n, 2);
});

test('runIngestPrices là idempotent — chạy hai lần không nhân đôi bars', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });

  await runIngestPrices({ broker, repos, logger: silent });
  await runIngestPrices({ broker, repos, logger: silent });

  const bars = await client.query('SELECT COUNT(*)::int AS n FROM ohlcv_daily');
  assert.equal(bars.rows[0].n, 120);
});

test('runIngestPrices tiếp tục khi một mã lỗi và ghi vào ingest_errors', async () => {
  const core = createFakeCore();
  const original = core.data.getOhlcv;
  core.data.getOhlcv = async function (...args) {
    if (core.currentSymbol === 'HOSE:VCB') throw new Error('chart chưa sẵn sàng');
    return original.apply(this, args);
  };
  const broker = createBroker({ core, logger: silent, sleep: noSleep, maxRetries: 1 });

  const summary = await runIngestPrices({ broker, repos, logger: silent });

  assert.equal(summary.succeeded, 1);
  assert.deepEqual(summary.failedSymbols, ['HOSE:VCB']);

  const errs = await client.query('SELECT job, symbol FROM ingest_errors');
  assert.equal(errs.rows.length, 1);
  assert.equal(errs.rows[0].job, 'ingest_prices');
  assert.equal(errs.rows[0].symbol, 'HOSE:VCB');
});

test('runIngestPrices đặt session_state là DATA_READY khi mọi mã thành công', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });
  const summary = await runIngestPrices({ broker, repos, logger: silent });

  const state = await repos.ops.getSessionState(summary.tradeDate);
  assert.equal(state.state, 'DATA_READY');
  assert.ok(state.data_captured_at instanceof Date);
});

test('runIngestPrices đặt session_state là DATA_STALE khi mọi mã đều lỗi', async () => {
  const core = createFakeCore({ failFirst: 99 });
  const broker = createBroker({ core, logger: silent, sleep: noSleep, maxRetries: 1 });

  const summary = await runIngestPrices({ broker, repos, logger: silent });

  assert.equal(summary.succeeded, 0);
  const state = await repos.ops.getSessionState(summary.tradeDate);
  assert.equal(state.state, 'DATA_STALE');
  assert.equal(state.data_captured_at, null);
});

test('runIngestPrices đặt session_state là DATA_PARTIAL khi một số mã lỗi và KHÔNG làm mới dataCapturedAt', async () => {
  const core = createFakeCore();
  const original = core.data.getOhlcv;
  core.data.getOhlcv = async function (...args) {
    if (core.currentSymbol === 'HOSE:VCB') throw new Error('chart chưa sẵn sàng');
    return original.apply(this, args);
  };
  const broker = createBroker({ core, logger: silent, sleep: noSleep, maxRetries: 1 });

  const summary = await runIngestPrices({ broker, repos, logger: silent });

  assert.equal(summary.succeeded, 1);
  assert.deepEqual(summary.failedSymbols, ['HOSE:VCB']);

  const state = await repos.ops.getSessionState(summary.tradeDate);
  assert.equal(state.state, 'DATA_PARTIAL');
  // Một lần chạy dở dang không được làm mới mốc "dữ liệu mới nhất" — đây là
  // lần chạy DUY NHẤT trong test này nên nếu bị làm mới, cột sẽ có giá trị.
  assert.equal(state.data_captured_at, null);
});

test('mã không đủ bar để tính chỉ báo bị tính là thất bại, giá vẫn được ghi', async () => {
  // Chỉ báo giờ TỰ TÍNH từ bars, không đọc từ TradingView. Mã mới lên sàn
  // chưa đủ 35 phiên thì không tính được RSI/MACD — phải coi là thất bại,
  // không được ghi một snapshot khuyết trông giống dữ liệu hợp lệ.
  const core = createFakeCore();
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  const summary = await runIngestPrices({ broker, repos, logger: silent, barCount: 10 });

  assert.equal(summary.succeeded, 0);
  assert.equal(summary.failedSymbols.length, 2);

  const state = await repos.ops.getSessionState(summary.tradeDate);
  assert.equal(state.state, 'DATA_STALE');
  assert.equal(state.data_captured_at, null);

  // Giá vẫn được ghi — bars hợp lệ độc lập với việc tính được chỉ báo hay không.
  const bars = await client.query('SELECT COUNT(*)::int AS n FROM ohlcv_daily');
  assert.equal(bars.rows[0].n, 20);

  const snaps = await client.query('SELECT COUNT(*)::int AS n FROM indicator_snapshot');
  assert.equal(snaps.rows[0].n, 0, 'snapshot khuyết còn tệ hơn không có snapshot');
});

test('một mã lỗi lấy giá không chặn mã còn lại, và vào DATA_PARTIAL', async () => {
  const core = createFakeCore();
  const original = core.data.getOhlcv;
  core.data.getOhlcv = async function (...args) {
    if (core.currentSymbol === 'HOSE:VCB') throw new Error('chart chưa sẵn sàng');
    return original.apply(this, args);
  };
  const broker = createBroker({ core, logger: silent, sleep: noSleep, maxRetries: 1 });

  const summary = await runIngestPrices({ broker, repos, logger: silent });

  assert.equal(summary.succeeded, 1);
  assert.deepEqual(summary.failedSymbols, ['HOSE:VCB']);

  const errs = await client.query(`SELECT symbol FROM ingest_errors`);
  assert.equal(errs.rows.length, 1);
  assert.equal(errs.rows[0].symbol, 'HOSE:VCB');

  const snaps = await client.query(
    `SELECT COUNT(*)::int AS n FROM indicator_snapshot WHERE symbol = 'HOSE:VCB'`);
  assert.equal(snaps.rows[0].n, 0);

  const state = await repos.ops.getSessionState(summary.tradeDate);
  assert.equal(state.state, 'DATA_PARTIAL');
  assert.equal(state.data_captured_at, null);
});

test('snapshot chỉ báo chứa giá trị thật, không phải object rỗng', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });
  await runIngestPrices({ broker, repos, logger: silent });

  const { rows } = await client.query(
    `SELECT payload FROM indicator_snapshot WHERE symbol = 'HOSE:FPT'`);
  assert.equal(rows.length, 1);

  const p = rows[0].payload;
  for (const key of ['rsi14', 'macd', 'bbBasis', 'atr14', 'ma20']) {
    assert.ok(Number.isFinite(Number(p[key])), `${key} phải là số, nhận ${p[key]}`);
  }
  assert.ok(Number(p.rsi14) >= 0 && Number(p.rsi14) <= 100, 'RSI phải trong 0..100');
});

test('runIngestPrices phát sự kiện data.ingested', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });
  await runIngestPrices({ broker, repos, logger: silent });

  const events = await repos.events.getEventsSince(0, 10);
  const ingested = events.find(e => e.type === 'data.ingested');
  assert.ok(ingested, 'phải có sự kiện data.ingested');
  assert.equal(ingested.payload.job, 'ingest_prices');
  assert.equal(ingested.payload.succeeded, 2);
});

test('runIngestPrices dừng sớm và phát data.stale khi CDP không kết nối được', async () => {
  const core = createFakeCore({ healthy: false });
  core.health.launch = async () => { throw new Error('không tìm thấy TradingView'); };
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  const summary = await runIngestPrices({ broker, repos, logger: silent });

  assert.equal(summary.total, 0);
  assert.equal(summary.succeeded, 0);

  const events = await repos.events.getEventsSince(0, 10);
  assert.ok(events.some(e => e.type === 'data.stale'));
});

test('runPollQuotes ghi tick cho các mã truyền vào', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });

  const result = await runPollQuotes({
    broker, repos, symbols: ['HOSE:FPT', 'HOSE:VCB'], logger: silent,
    // Thứ Hai 10:00 giờ VN — trong cửa sổ giao dịch (isTradingWindow), tường
    // minh chứ không phụ thuộc đồng hồ máy chạy test (finding scheduler
    // task 9: poll_quotes giờ bỏ qua ngoài giờ giao dịch).
    now: new Date('2026-07-20T10:00:00+07:00'),
  });

  assert.equal(result.inserted, 2);
  assert.equal(result.failed, 0);

  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM quote_tick');
  assert.equal(rows[0].n, 2);
});

test('runPollQuotes bỏ qua ngoài giờ giao dịch, không ghi tick', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });

  const result = await runPollQuotes({
    broker, repos, symbols: ['HOSE:FPT', 'HOSE:VCB'], logger: silent,
    now: new Date('2026-07-20T12:00:00+07:00'), // giờ nghỉ trưa
  });

  assert.deepEqual(result, { inserted: 0, failed: 0, skipped: true });
});

test('runPollQuotes bỏ qua ngày nghỉ lễ dù đang trong giờ giao dịch', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });
  // 2026-07-20 là thứ Hai 10:00 — test ngay trên đã chứng minh nó ghi được
  // tick. Thêm đúng ngày đó vào lịch lễ thì phải chuyển thành bỏ qua.
  await client.query(
    `INSERT INTO market_holidays (holiday_date, name) VALUES ('2026-07-20', 'Nghỉ thử')
     ON CONFLICT DO NOTHING`);

  const result = await runPollQuotes({
    broker, repos, symbols: ['HOSE:FPT'], logger: silent,
    now: new Date('2026-07-20T10:00:00+07:00'),
  });

  assert.deepEqual(result, { inserted: 0, failed: 0, skipped: true });
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM quote_tick');
  assert.equal(rows[0].n, 0, 'ngày sàn đóng cửa không được sinh tick nào');
});

test('runPollQuotes không làm gì khi danh sách mã rỗng', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });
  const result = await runPollQuotes({ broker, repos, symbols: [], logger: silent });
  assert.deepEqual(result, { inserted: 0, failed: 0 });
});

test('runPruneEvents xóa sự kiện quá hạn', async () => {
  await client.query(
    `INSERT INTO event_log (ts, type, payload) VALUES (now() - interval '100 days', 'old', '{}')`);
  await repos.events.appendEvent({ type: 'new', payload: {} });

  const result = await runPruneEvents({ repos, retentionDays: 90, logger: silent });
  assert.equal(result.deleted, 1);
});
