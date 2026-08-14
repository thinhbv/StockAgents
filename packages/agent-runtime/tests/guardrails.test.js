import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RISK, checkBuy, checkSell, checkDailyLoss } from '../src/sim/guardrails.js';

const NAV = 1_000_000_000;
const pos = (symbol, qtyTotal, qtySellable = qtyTotal) => ({ symbol, qtyTotal, qtySellable });

test('giá trị rủi ro mặc định đúng spec §7.2', () => {
  assert.deepEqual({ ...DEFAULT_RISK }, { maxPositionPctNav: 20, dailyLossLimitPct: 5 });
});

test('checkBuy cho qua khi mọi giới hạn thoả', () => {
  const r = checkBuy({ symbol: 'HOSE:FPT', costVnd: 100_000_000, cash: 500_000_000, nav: NAV, positions: [], risk: DEFAULT_RISK });
  assert.equal(r.ok, true);
});

test('checkBuy chặn khi không đủ tiền mặt — không đòn bẩy', () => {
  const r = checkBuy({ symbol: 'HOSE:FPT', costVnd: 600_000_000, cash: 500_000_000, nav: NAV, positions: [], risk: DEFAULT_RISK });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tiền mặt/);
});

test('checkBuy chặn khi vượt tỷ trọng tối đa một mã', () => {
  const r = checkBuy({ symbol: 'HOSE:FPT', costVnd: 250_000_000, cash: NAV, nav: NAV, positions: [], risk: DEFAULT_RISK });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tỷ trọng/);
});

test('checkBuy KHÔNG giới hạn số loại mã đang giữ — agent tự quyết định dàn trải', () => {
  // 20 mã khác nhau, mỗi lệnh nhỏ để không chạm trần tỷ trọng/mã hay tiền mặt.
  const positions = Array.from({ length: 20 }, (_, i) => pos(`HOSE:S${i}`, 100));
  const r = checkBuy({ symbol: 'HOSE:NEW', costVnd: 10_000_000, cash: NAV, nav: NAV, positions, risk: DEFAULT_RISK });
  assert.equal(r.ok, true, 'không có hàng rào số vị thế — tiền mặt và tỷ trọng/mã mới là hàng rào thật');
});

test('checkBuy chặn khi thiếu chỉ báo kỹ thuật cho mã, dù mọi giới hạn khác thoả', () => {
  const r = checkBuy({
    symbol: 'HOSE:FPT', costVnd: 100_000_000, cash: 500_000_000, nav: NAV,
    positions: [], risk: DEFAULT_RISK, indicatorsMissing: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /chỉ báo/);
});

test('checkSell chặn khi không có vị thế', () => {
  const r = checkSell({ symbol: 'HOSE:FPT', qty: 100, positions: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /không có vị thế/);
});

test('checkSell chặn bán quá số lượng bán được — không bán khống', () => {
  const r = checkSell({ symbol: 'HOSE:FPT', qty: 1000, positions: [pos('HOSE:FPT', 1000, 500)] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /T\+2|bán được/);
});

test('checkSell cho qua khi bán trong phần đã về tài khoản', () => {
  const r = checkSell({ symbol: 'HOSE:FPT', qty: 500, positions: [pos('HOSE:FPT', 1000, 500)] });
  assert.equal(r.ok, true);
});

test('checkDailyLoss chặn khi lỗ ngày vượt ngưỡng', () => {
  const r = checkDailyLoss({ dayPnl: -60_000_000, nav: NAV, risk: DEFAULT_RISK });
  assert.equal(r.ok, false);
  assert.match(r.reason, /lỗ trong ngày/);
});

test('checkDailyLoss cho qua khi lỗ chưa tới ngưỡng, và khi đang lãi', () => {
  assert.equal(checkDailyLoss({ dayPnl: -40_000_000, nav: NAV, risk: DEFAULT_RISK }).ok, true);
  assert.equal(checkDailyLoss({ dayPnl: 40_000_000, nav: NAV, risk: DEFAULT_RISK }).ok, true);
});

test('guardrails không bao giờ ném lỗi, kể cả đầu vào rác', () => {
  assert.doesNotThrow(() => checkBuy({ symbol: 'X', costVnd: NaN, cash: null, nav: 0, positions: [], risk: DEFAULT_RISK }));
  const r = checkBuy({ symbol: 'X', costVnd: NaN, cash: null, nav: 0, positions: [], risk: DEFAULT_RISK });
  assert.equal(r.ok, false);
});
