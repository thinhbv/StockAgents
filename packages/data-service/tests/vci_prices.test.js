import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectVciQuotes, collectVciDailyBars } from '../src/collectors/vci_prices.js';

function quoteRow(ticker, {
  matchPrice = 22200, accumulatedVolume = 100000,
  ceilingPrice = 23750, floorPrice = 20650, referencePrice = 22200,
} = {}) {
  return {
    listingInfo: { symbol: ticker },
    matchPrice: { matchPrice, accumulatedVolume, ceilingPrice, floorPrice, referencePrice },
  };
}

function barsRow(ticker, { count = 3, close = [22000, 22200, 22500], volume = [1000, 1100, 1200] } = {}) {
  const t = Array.from({ length: count }, (_, i) => String(1788480000 - (count - 1 - i) * 86400));
  return {
    symbol: ticker,
    t,
    o: close.map(c => c - 50),
    h: close.map(c => c + 100),
    l: close.map(c => c - 100),
    c: close,
    v: volume,
  };
}

/* ---------- collectVciQuotes ---------- */

test('collectVciQuotes trả giá + trần/sàn/tham chiếu cho các mã có trong response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [quoteRow('ACB'), quoteRow('FPT', { matchPrice: 72800 })] });
  const { ticks, errors } = await collectVciQuotes(['HOSE:ACB', 'HOSE:FPT'], fetchImpl);

  assert.equal(errors.length, 0);
  assert.deepEqual(ticks.map(t => t.symbol).sort(), ['HOSE:ACB', 'HOSE:FPT']);
  const acb = ticks.find(t => t.symbol === 'HOSE:ACB');
  assert.equal(acb.price, 22200);
  assert.equal(acb.ceiling, 23750);
  assert.equal(acb.floor, 20650);
  assert.equal(acb.refPrice, 22200);
});

test('collectVciQuotes gộp CẢ universe trong MỘT lần gọi HTTP', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    return { ok: true, json: async () => [quoteRow('ACB'), quoteRow('FPT')] };
  };
  await collectVciQuotes(['HOSE:ACB', 'HOSE:FPT'], fetchImpl);
  assert.equal(callCount, 1);
});

test('collectVciQuotes báo lỗi riêng cho mã không có trong response, không chặn mã khác', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [quoteRow('ACB')] });
  const { ticks, errors } = await collectVciQuotes(['HOSE:ACB', 'HOSE:XXXX'], fetchImpl);

  assert.equal(ticks.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].symbol, 'HOSE:XXXX');
  assert.match(errors[0].message, /không có trong response/);
});

test('collectVciQuotes báo lỗi khi giá khớp không hợp lệ thay vì ghi NaN/0 âm thầm', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [quoteRow('ACB', { matchPrice: 0 })] });
  const { ticks, errors } = await collectVciQuotes(['HOSE:ACB'], fetchImpl);

  assert.equal(ticks.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /giá khớp không hợp lệ/);
});

test('collectVciQuotes ném lỗi rõ khi HTTP lỗi', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => collectVciQuotes(['HOSE:ACB'], fetchImpl), /HTTP 500/);
});

test('collectVciQuotes với danh sách rỗng không gọi mạng', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => [] }; };
  const { ticks, errors } = await collectVciQuotes([], fetchImpl);
  assert.equal(called, false);
  assert.deepEqual(ticks, []);
  assert.deepEqual(errors, []);
});

/* ---------- collectVciDailyBars ---------- */

test('collectVciDailyBars trả bars đã chuẩn hóa sang ngày giao dịch VN, cũ→mới', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [barsRow('ACB', { count: 3, close: [22000, 22200, 22500] })],
  });
  const bars = await collectVciDailyBars('HOSE:ACB', { count: 3, fetchImpl });

  assert.equal(bars.length, 3);
  assert.equal(bars[2].close, 22500, 'bar cuối cùng là mới nhất');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(bars[0].tradeDate));
});

test('collectVciDailyBars gửi countBack — thiếu tham số này API thật trả 400', async () => {
  let sentBody;
  const fetchImpl = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, json: async () => [barsRow('ACB', { count: 1 })] };
  };
  await collectVciDailyBars('HOSE:ACB', { count: 42, fetchImpl });
  assert.equal(sentBody.countBack, 42);
  assert.deepEqual(sentBody.symbols, ['ACB']);
  assert.equal(sentBody.timeFrame, 'ONE_DAY');
});

test('collectVciDailyBars ném lỗi khi mã không có trong response (mảng rỗng)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  await assert.rejects(() => collectVciDailyBars('HOSE:ACB', { fetchImpl }), /không có bar nào trả về/);
});

test('collectVciDailyBars ném lỗi khi một trường giá là NaN thay vì ghi âm thầm', async () => {
  const row = barsRow('ACB', { count: 1 });
  row.c = [undefined];
  const fetchImpl = async () => ({ ok: true, json: async () => [row] });
  await assert.rejects(() => collectVciDailyBars('HOSE:ACB', { fetchImpl }), /trường 'close' không hợp lệ/);
});

test('collectVciDailyBars làm tròn volume thập phân — cột BIGINT không nhận số lẻ', async () => {
  const row = barsRow('ACB', { count: 1 });
  row.v = [1234567.89];
  const fetchImpl = async () => ({ ok: true, json: async () => [row] });
  const bars = await collectVciDailyBars('HOSE:ACB', { fetchImpl });
  assert.equal(bars[0].volume, 1234568);
});

test('collectVciDailyBars ném lỗi rõ khi HTTP lỗi', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(
    () => collectVciDailyBars('HOSE:ACB', { fetchImpl, maxRetries: 1 }), /HTTP 500/);
});

test('collectVciDailyBars thử lại khi lỗi thoáng qua, thành công ở lần sau', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => [barsRow('ACB', { count: 1 })] };
  };
  const bars = await collectVciDailyBars('HOSE:ACB', {
    fetchImpl, maxRetries: 2, sleep: async () => {},
  });
  assert.equal(calls, 2);
  assert.equal(bars.length, 1);
});
