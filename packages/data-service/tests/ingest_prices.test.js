import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { runIngestPrices } from '../src/jobs/ingest_prices.js';
import { runPollQuotes } from '../src/jobs/poll_quotes.js';
import { runPruneEvents } from '../src/jobs/prune_events.js';
import {
  createUniverseRepo, createMarketRepo, createOpsRepo, createEventsRepo,
} from '@stockagents/db';

const silent = { info() {}, warn() {}, error() {} };
const DAY = 86400;

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

/**
 * Fake của endpoint chart/OHLCChart/gap-chart — tra theo ticker trong
 * `barsByTicker`; ticker không có trong map coi như VCI không trả (mảng
 * rỗng), giống hệt xử lý khi mã lỗi/không niêm yết.
 */
function makeBarsFetch(barsByTicker) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    const ticker = body.symbols[0];
    const rows = barsByTicker[ticker];
    return { ok: true, json: async () => (rows ? [rows] : []) };
  };
}

/** `count` bar dao động nhẹ quanh 100 — đủ cho computeIndicators tính RSI/MACD/... (cần ≥35 bar). */
function genBars(ticker, count) {
  const t = [], o = [], h = [], l = [], c = [], v = [];
  const start = 1784592000 - (count - 1) * DAY;
  for (let i = 0; i < count; i++) {
    const base = 100 + Math.sin(i / 3) * 5 + i * 0.1;
    t.push(String(start + i * DAY));
    o.push(base); h.push(base + 1.5); l.push(base - 1.5); c.push(base + 0.5); v.push(1000 + i);
  }
  return { symbol: ticker, t, o, h, l, c, v };
}

test('runIngestPrices ghi bars và indicator snapshot cho mọi mã', async () => {
  const fetchImpl = makeBarsFetch({ FPT: genBars('FPT', 60), VCB: genBars('VCB', 60) });

  const summary = await runIngestPrices({ repos, logger: silent, fetchImpl });

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
  const fetchImpl = makeBarsFetch({ FPT: genBars('FPT', 60), VCB: genBars('VCB', 60) });

  await runIngestPrices({ repos, logger: silent, fetchImpl });
  await runIngestPrices({ repos, logger: silent, fetchImpl });

  const bars = await client.query('SELECT COUNT(*)::int AS n FROM ohlcv_daily');
  assert.equal(bars.rows[0].n, 120);
});

test('runIngestPrices tiếp tục khi một mã lỗi và ghi vào ingest_errors', async () => {
  // VCB không có trong map -> collectVciDailyBars ném lỗi "không có bar nào trả về".
  const fetchImpl = makeBarsFetch({ FPT: genBars('FPT', 60) });

  const summary = await runIngestPrices({ repos, logger: silent, fetchImpl });

  assert.equal(summary.succeeded, 1);
  assert.deepEqual(summary.failedSymbols, ['HOSE:VCB']);

  const errs = await client.query('SELECT job, symbol FROM ingest_errors');
  assert.equal(errs.rows.length, 1);
  assert.equal(errs.rows[0].job, 'ingest_prices');
  assert.equal(errs.rows[0].symbol, 'HOSE:VCB');
});

test('runIngestPrices đặt session_state là DATA_READY khi mọi mã thành công', async () => {
  const fetchImpl = makeBarsFetch({ FPT: genBars('FPT', 60), VCB: genBars('VCB', 60) });
  const summary = await runIngestPrices({ repos, logger: silent, fetchImpl });

  const state = await repos.ops.getSessionState(summary.tradeDate);
  assert.equal(state.state, 'DATA_READY');
  assert.ok(state.data_captured_at instanceof Date);
});

test('runIngestPrices đặt session_state là DATA_STALE khi mọi mã đều lỗi', async () => {
  const fetchImpl = makeBarsFetch({}); // không mã nào có bar

  const summary = await runIngestPrices({ repos, logger: silent, fetchImpl });

  assert.equal(summary.succeeded, 0);
  const state = await repos.ops.getSessionState(summary.tradeDate);
  assert.equal(state.state, 'DATA_STALE');
  assert.equal(state.data_captured_at, null);
});

test('runIngestPrices đặt session_state là DATA_PARTIAL khi một số mã lỗi và KHÔNG làm mới dataCapturedAt', async () => {
  const fetchImpl = makeBarsFetch({ FPT: genBars('FPT', 60) });

  const summary = await runIngestPrices({ repos, logger: silent, fetchImpl });

  assert.equal(summary.succeeded, 1);
  assert.deepEqual(summary.failedSymbols, ['HOSE:VCB']);

  const state = await repos.ops.getSessionState(summary.tradeDate);
  assert.equal(state.state, 'DATA_PARTIAL');
  // Một lần chạy dở dang không được làm mới mốc "dữ liệu mới nhất" — đây là
  // lần chạy DUY NHẤT trong test này nên nếu bị làm mới, cột sẽ có giá trị.
  assert.equal(state.data_captured_at, null);
});

test('mã không đủ bar để tính chỉ báo bị tính là thất bại, giá vẫn được ghi', async () => {
  // Chỉ báo TỰ TÍNH từ bars. Mã mới lên sàn chưa đủ 35 phiên thì không tính
  // được RSI/MACD — phải coi là thất bại, không được ghi một snapshot khuyết
  // trông giống dữ liệu hợp lệ.
  const fetchImpl = makeBarsFetch({ FPT: genBars('FPT', 10), VCB: genBars('VCB', 10) });

  const summary = await runIngestPrices({ repos, logger: silent, barCount: 10, fetchImpl });

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
  const fetchImpl = makeBarsFetch({ FPT: genBars('FPT', 60) });

  const summary = await runIngestPrices({ repos, logger: silent, fetchImpl });

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
  const fetchImpl = makeBarsFetch({ FPT: genBars('FPT', 60), VCB: genBars('VCB', 60) });
  await runIngestPrices({ repos, logger: silent, fetchImpl });

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
  const fetchImpl = makeBarsFetch({ FPT: genBars('FPT', 60), VCB: genBars('VCB', 60) });
  await runIngestPrices({ repos, logger: silent, fetchImpl });

  const events = await repos.events.getEventsSince(0, 10);
  const ingested = events.find(e => e.type === 'data.ingested');
  assert.ok(ingested, 'phải có sự kiện data.ingested');
  assert.equal(ingested.payload.job, 'ingest_prices');
  assert.equal(ingested.payload.succeeded, 2);
});

test('runIngestPrices phát data.stale khi nguồn HTTP lỗi cho mọi mã', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });

  const summary = await runIngestPrices({ repos, logger: silent, fetchImpl, maxRetries: 1 });

  assert.equal(summary.total, 2);
  assert.equal(summary.succeeded, 0);

  const events = await repos.events.getEventsSince(0, 10);
  assert.ok(events.some(e => e.type === 'data.stale'));
});

/* ---------- runPollQuotes ---------- */

function quoteRow(ticker, {
  matchPrice = 100, accumulatedVolume = 5000,
  ceilingPrice = 107, floorPrice = 93, referencePrice = 100,
} = {}) {
  return {
    listingInfo: { symbol: ticker },
    matchPrice: { matchPrice, accumulatedVolume, ceilingPrice, floorPrice, referencePrice },
  };
}

function makeQuotesFetch(rows) {
  return async () => ({ ok: true, json: async () => rows });
}

test('runPollQuotes ghi tick cho các mã truyền vào', async () => {
  const fetchImpl = makeQuotesFetch([quoteRow('FPT'), quoteRow('VCB')]);

  const result = await runPollQuotes({
    repos, symbols: ['HOSE:FPT', 'HOSE:VCB'], logger: silent, fetchImpl,
    // Thứ Hai 10:00 giờ VN — trong cửa sổ giao dịch (isTradingWindow), tường
    // minh chứ không phụ thuộc đồng hồ máy chạy test.
    now: new Date('2026-07-20T10:00:00+07:00'),
  });

  assert.equal(result.inserted, 2);
  assert.equal(result.failed, 0);

  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM quote_tick');
  assert.equal(rows[0].n, 2);
});

test('runPollQuotes bỏ qua ngoài giờ giao dịch, không ghi tick', async () => {
  const fetchImpl = makeQuotesFetch([quoteRow('FPT'), quoteRow('VCB')]);

  const result = await runPollQuotes({
    repos, symbols: ['HOSE:FPT', 'HOSE:VCB'], logger: silent, fetchImpl,
    now: new Date('2026-07-20T12:00:00+07:00'), // giờ nghỉ trưa
  });

  assert.deepEqual(result, { inserted: 0, failed: 0, skipped: true });
});

test('runPollQuotes bỏ qua ngày nghỉ lễ dù đang trong giờ giao dịch', async () => {
  const fetchImpl = makeQuotesFetch([quoteRow('FPT')]);
  // 2026-07-20 là thứ Hai 10:00 — test ngay trên đã chứng minh nó ghi được
  // tick. Thêm đúng ngày đó vào lịch lễ thì phải chuyển thành bỏ qua.
  await client.query(
    `INSERT INTO market_holidays (holiday_date, name) VALUES ('2026-07-20', 'Nghỉ thử')
     ON CONFLICT DO NOTHING`);

  const result = await runPollQuotes({
    repos, symbols: ['HOSE:FPT'], logger: silent, fetchImpl,
    now: new Date('2026-07-20T10:00:00+07:00'),
  });

  assert.deepEqual(result, { inserted: 0, failed: 0, skipped: true });
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM quote_tick');
  assert.equal(rows[0].n, 0, 'ngày sàn đóng cửa không được sinh tick nào');
});

test('runPollQuotes bỏ tick nằm ngoài trần/sàn CHÍNH THỨC do VCI trả — nghi dữ liệu rác', async () => {
  // Mô phỏng đúng bug thật đã gặp: giá khớp vượt xa ceilingPrice mà nguồn
  // tự trả về (ACB 22.500 -> "25.350" ngày 2026-08-25, trần thật chỉ 23.750).
  const fetchImpl = makeQuotesFetch([
    quoteRow('FPT', { matchPrice: 150, ceilingPrice: 107, floorPrice: 93 }),
  ]);

  const result = await runPollQuotes({
    repos, symbols: ['HOSE:FPT'], logger: silent, fetchImpl,
    now: new Date('2026-07-20T10:00:00+07:00'),
  });

  assert.equal(result.inserted, 0, 'tick ngoài biên độ không được ghi');
  assert.equal(result.failed, 1);
  const { rows } = await client.query(
    `SELECT message FROM ingest_errors WHERE symbol = 'HOSE:FPT' ORDER BY id DESC LIMIT 1`);
  assert.match(rows[0].message, /ngoài biên độ/);
});

test('runPollQuotes vẫn ghi tick nằm trong trần/sàn do VCI trả', async () => {
  const fetchImpl = makeQuotesFetch([
    quoteRow('FPT', { matchPrice: 105, ceilingPrice: 107, floorPrice: 93 }),
  ]);

  const result = await runPollQuotes({
    repos, symbols: ['HOSE:FPT'], logger: silent, fetchImpl,
    now: new Date('2026-07-20T10:00:00+07:00'),
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.failed, 0);
});

test('runPollQuotes dùng ohlcv_daily làm lưới an toàn khi VCI không trả trần/sàn', async () => {
  await client.query(
    `INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
     VALUES ('HOSE:FPT', '2026-07-19', 10000, 10000, 10000, 10000, 1000)`);
  // matchPrice=134 nhưng KHÔNG có ceilingPrice/floorPrice -> rơi về tính từ
  // ohlcv_daily (tham chiếu 10.000, band ±7% loại bỏ 134 ngay).
  const fetchImpl = makeQuotesFetch([
    quoteRow('FPT', { matchPrice: 134, ceilingPrice: null, floorPrice: null }),
  ]);

  const result = await runPollQuotes({
    repos, symbols: ['HOSE:FPT'], logger: silent, fetchImpl,
    now: new Date('2026-07-20T10:00:00+07:00'),
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.failed, 1);
});

test('runPollQuotes không làm gì khi danh sách mã rỗng', async () => {
  const fetchImpl = makeQuotesFetch([]);
  const result = await runPollQuotes({ repos, symbols: [], logger: silent, fetchImpl });
  assert.deepEqual(result, { inserted: 0, failed: 0 });
});

test('runPruneEvents xóa sự kiện quá hạn', async () => {
  await client.query(
    `INSERT INTO event_log (ts, type, payload) VALUES (now() - interval '100 days', 'old', '{}')`);
  await repos.events.appendEvent({ type: 'new', payload: {} });

  const result = await runPruneEvents({ repos, retentionDays: 90, logger: silent });
  assert.equal(result.deleted, 1);
});
