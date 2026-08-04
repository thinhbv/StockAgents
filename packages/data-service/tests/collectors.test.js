import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../src/cdp/broker.js';
import { createFakeCore } from '../../../tests/helpers/fake_core.js';
import { collectPrices } from '../src/collectors/prices.js';
import { collectIndicators, parseStudyValues, REQUIRED_INDICATOR_KEYS } from '../src/collectors/indicators.js';
import { collectQuotes } from '../src/collectors/quotes.js';
import { ensureStudies, REQUIRED_STUDIES } from '../src/cdp/studies.js';

const silent = { info() {}, warn() {}, error() {} };
const noSleep = () => Promise.resolve();
const makeBroker = (opts) =>
  createBroker({ core: createFakeCore(opts), logger: silent, sleep: noSleep });

test('collectPrices trả về bars đã chuẩn hóa sang ngày giao dịch VN', async () => {
  const bars = await collectPrices(makeBroker(), 'HOSE:FPT', { count: 3 });

  assert.equal(bars.length, 3);
  // Fake sinh bar liên tiếp kết thúc ở 2026-07-21 (unix 1784592000).
  assert.equal(bars[bars.length - 1].tradeDate, '2026-07-21');
  assert.equal(bars[0].tradeDate, '2026-07-19');
  for (const b of bars) {
    for (const k of ['open', 'high', 'low', 'close', 'volume']) {
      assert.ok(Number.isFinite(b[k]), `${k} phải là số hữu hạn`);
    }
  }
});

test('collectPrices báo lỗi khi chart trả về mảng bars rỗng', async () => {
  const core = createFakeCore();
  core.data.getOhlcv = async () => ({ success: true, bar_count: 0, bars: [] });
  const broker = createBroker({ core, logger: silent, sleep: noSleep, maxRetries: 1 });

  await assert.rejects(collectPrices(broker, 'HOSE:FPT', { count: 60 }), /không có bar/);
});

test('parseStudyValues chuyển giá trị chuỗi thành số theo khóa chuẩn', () => {
  const parsed = parseStudyValues([
    { name: 'Relative Strength Index', values: { RSI: '62.53' } },
    { name: 'Moving Average Simple', values: { Plot: '105.20' } },
    { name: 'MACD', values: { MACD: '1.25', Signal: '0.98', Histogram: '0.27' } },
    { name: 'Bollinger Bands', values: { Upper: '115.0', Basis: '105.0', Lower: '95.0' } },
    { name: 'Average True Range', values: { ATR: '2.35' } },
  ]);

  assert.equal(parsed.rsi14, 62.53);
  assert.equal(parsed.macd, 1.25);
  assert.equal(parsed.macdSignal, 0.98);
  assert.equal(parsed.macdHist, 0.27);
  assert.equal(parsed.bbUpper, 115);
  assert.equal(parsed.bbBasis, 105);
  assert.equal(parsed.bbLower, 95);
  assert.equal(parsed.atr14, 2.35);
});

test('parseStudyValues bỏ qua giá trị không phân tích được thay vì ném lỗi', () => {
  const parsed = parseStudyValues([
    { name: 'Relative Strength Index', values: { RSI: 'n/a' } },
    { name: 'Average True Range', values: { ATR: '2.35' } },
  ]);
  assert.equal(parsed.rsi14, undefined);
  assert.equal(parsed.atr14, 2.35);
});

test('parseStudyValues xử lý mảng rỗng', () => {
  assert.deepEqual(parseStudyValues([]), {});
});

test('collectIndicators trả về cả raw và parsed', async () => {
  const result = await collectIndicators(makeBroker(), 'HOSE:FPT');

  assert.equal(result.parsed.rsi14, 62.53);
  assert.equal(result.raw.length, 5);
});

test('collectQuotes gom tick và tách riêng lỗi từng mã', async () => {
  const core = createFakeCore();
  let calls = 0;
  const originalGetQuote = core.data.getQuote;
  core.data.getQuote = async function (...args) {
    calls++;
    if (calls === 2) throw new Error('quote không khả dụng');
    return originalGetQuote.apply(this, args);
  };
  const broker = createBroker({ core, logger: silent, sleep: noSleep, maxRetries: 1 });

  const { ticks, errors } = await collectQuotes(broker, ['HOSE:A', 'HOSE:B', 'HOSE:C']);

  assert.deepEqual(ticks.map(t => t.symbol), ['HOSE:A', 'HOSE:C']);
  // Giá lấy từ `last` của quote thật, không phải trường `price` (không tồn tại)
  assert.equal(ticks[0].price, 111);
  assert.ok(Number.isFinite(ticks[0].price), 'không được là NaN');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].symbol, 'HOSE:B');
});

test('collectQuotes với danh sách rỗng trả về kết quả rỗng, không chạm CDP', async () => {
  const core = createFakeCore();
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  const { ticks, errors } = await collectQuotes(broker, []);
  assert.deepEqual(ticks, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(core.calls, []);
});

test('ensureStudies thêm các chỉ báo còn thiếu và bỏ qua chỉ báo đã có', async () => {
  const core = createFakeCore();
  core.chart.getState = async () => ({
    success: true,
    studies: [{ id: 'x1', name: 'Relative Strength Index' }],
  });
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  const added = await ensureStudies(broker);

  assert.ok(!added.includes('Relative Strength Index'), 'không thêm lại chỉ báo đã có');
  assert.equal(added.length, REQUIRED_STUDIES.length - 1);
  assert.ok(core.calls.some(c => c === 'manageIndicator:add:Average True Range'));
});

test('ensureStudies thêm Moving Average Simple với length:20, không dùng chu kỳ mặc định', async () => {
  const core = createFakeCore();
  core.chart.getState = async () => ({ success: true, studies: [] });
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  await ensureStudies(broker);

  assert.ok(
    core.calls.includes('manageIndicator:add:Moving Average Simple:{"length":20}'),
    'phải truyền inputs:{length:20}, không được dùng chu kỳ mặc định (9) của TradingView',
  );
});

test('collectIndicators ném lỗi khi getStudyValues trả về rỗng (Finding 1: studies chưa sẵn sàng)', async () => {
  // Mirrors tradingview_mcp/src/core/data.js:324-358 getStudyValues — nó KHÔNG
  // BAO GIỜ ném lỗi, kể cả khi study chưa kịp tính lại sau setSymbol; nó trả
  // {success:true, study_count:0, studies:[]}. Một snapshot rỗng trông giống
  // dữ liệu hợp lệ nên phải coi là lỗi thu thập, không phải thành công.
  const broker = makeBroker({ studiesReady: false });

  await assert.rejects(
    collectIndicators(broker, 'HOSE:FPT'),
    (err) => {
      assert.match(err.message, /HOSE:FPT/);
      for (const key of REQUIRED_INDICATOR_KEYS) {
        assert.match(err.message, new RegExp(key));
      }
      return true;
    },
  );
});

test('collectIndicators ném lỗi khi thiếu MỘT trong các khóa bắt buộc', async () => {
  const core = createFakeCore();
  core.data.getStudyValues = async () => ({
    success: true, study_count: 1,
    studies: [{ name: 'Relative Strength Index', values: { RSI: '62.53' } }],
  });
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  await assert.rejects(collectIndicators(broker, 'HOSE:FPT'), /macd|bbBasis|atr14/);
});

test('collectPrices ném lỗi khi một trường giá là NaN thay vì ghi âm thầm', async () => {
  const core = createFakeCore();
  core.data.getOhlcv = async () => ({
    success: true, bar_count: 1,
    bars: [{ time: 1784592000, open: 100, high: 110, low: 99, volume: 1000 }], // thiếu close
  });
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  await assert.rejects(
    collectPrices(broker, 'HOSE:FPT', { count: 60 }),
    (err) => {
      assert.match(err.message, /HOSE:FPT/);
      assert.match(err.message, /close/);
      return true;
    },
  );
});

test('collectQuotes ném lỗi khi symbol trả về không khớp mã yêu cầu (chart chưa chuyển xong)', async () => {
  const core = createFakeCore();
  const original = core.data.getQuote;
  core.data.getQuote = async function (...args) {
    const q = await original.apply(this, args);
    return { ...q, symbol: 'HOSE:WRONG' };
  };
  const broker = createBroker({ core, logger: silent, sleep: noSleep, maxRetries: 1 });

  const { ticks, errors } = await collectQuotes(broker, ['HOSE:FPT']);

  assert.deepEqual(ticks, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /HOSE:WRONG/);
});

test('volume thập phân được làm tròn — cột BIGINT không nhận số lẻ', async () => {
  const core = createFakeCore();
  core.data.getOhlcv = async () => ({
    success: true, bar_count: 1,
    bars: [{ time: 1784592000, open: 100, high: 110, low: 99, close: 108, volume: 3989132.0032604 }],
  });
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  const bars = await collectPrices(broker, 'HOSE:VJC', { count: 1 });
  assert.equal(bars[0].volume, 3989132);
  assert.ok(Number.isInteger(bars[0].volume), 'phải là số nguyên trước khi chạm DB');
});
