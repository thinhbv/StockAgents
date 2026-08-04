import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo, createLessonsRepo } from '@stockagents/db';
import { matchSell, recordOutcomes } from '../src/sim/outcomes.js';
import {
  winRate, sharpe, maxDrawdown, avgHoldingDays, lessonHitRate,
  dailyReturns, computeAndSaveMetrics,
} from '../src/sim/metrics.js';

const silent = { info() {}, warn() {}, error() {} };
let client, repos;
const TABLES = ['lesson_usage', 'lessons', 'position_lots', 'fills', 'orders',
  'trade_outcomes', 'trades', 'positions', 'portfolio_snapshot', 'metrics_daily',
  'agents', 'universe'];

before(async () => {
  client = await withTestDb();
  repos = {
    agents: createAgentsRepo(client), trading: createTradingRepo(client),
    lessons: createLessonsRepo(client),
  };
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE'),('HOSE:VCB','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
    { id: 'a2', name: 'A2', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

const buy = (agentId, symbol, qty, priceVnd) => repos.trading.insertTrade(agentId, {
  symbol, action: 'BUY', priceVnd, qty, reason: 'mua', confidence: 0.7,
});
const sell = (agentId, symbol, qty, priceVnd) => repos.trading.insertTrade(agentId, {
  symbol, action: 'SELL', priceVnd, qty, reason: 'bán', confidence: 0.7,
});

/* ---------- Ghép vòng ---------- */

test('bán khớp với lệnh mua CŨ NHẤT trước (FIFO)', () => {
  const openBuys = [
    { tradeId: 1, qtyRemaining: 100, priceVnd: 50_000, decidedAt: '2026-07-01' },
    { tradeId: 2, qtyRemaining: 100, priceVnd: 60_000, decidedAt: '2026-07-05' },
  ];
  const rounds = matchSell({
    sell: { tradeId: 9, symbol: 'HOSE:FPT', qty: 100, priceVnd: 70_000, decidedAt: '2026-07-10' },
    openBuys,
  });

  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].entryTradeId, 1, 'phải tiêu lô mua cũ nhất');
  assert.equal(openBuys[1].qtyRemaining, 100, 'lô mới chưa bị đụng');
});

test('một lệnh bán có thể ghép nhiều lệnh mua', () => {
  const openBuys = [
    { tradeId: 1, qtyRemaining: 100, priceVnd: 50_000, decidedAt: '2026-07-01' },
    { tradeId: 2, qtyRemaining: 100, priceVnd: 60_000, decidedAt: '2026-07-05' },
  ];
  const rounds = matchSell({
    sell: { tradeId: 9, symbol: 'HOSE:FPT', qty: 150, priceVnd: 70_000, decidedAt: '2026-07-10' },
    openBuys,
  });

  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].qty, 100);
  assert.equal(rounds[1].qty, 50);
  assert.equal(openBuys[1].qtyRemaining, 50);
});

test('PnL tính TRÊN TIỀN THỰC — mua bán cùng giá phải LỖ đúng phí và thuế', () => {
  const rounds = matchSell({
    sell: { tradeId: 9, symbol: 'HOSE:FPT', qty: 1000, priceVnd: 50_000, decidedAt: '2026-07-10' },
    openBuys: [{ tradeId: 1, qtyRemaining: 1000, priceVnd: 50_000, decidedAt: '2026-07-01' }],
  });

  assert.ok(rounds[0].pnl < 0, 'cùng giá mà báo hoà vốn là bỏ quên phí');
  // phí mua 0,15% + phí bán 0,15% + thuế 0,1% trên 50 triệu
  assert.equal(rounds[0].pnl, -(75_000 + 75_000 + 50_000));
});

test('vòng có lãi khi giá bán đủ bù phí', () => {
  const rounds = matchSell({
    sell: { tradeId: 9, symbol: 'HOSE:FPT', qty: 1000, priceVnd: 60_000, decidedAt: '2026-07-10' },
    openBuys: [{ tradeId: 1, qtyRemaining: 1000, priceVnd: 50_000, decidedAt: '2026-07-01' }],
  });
  assert.ok(rounds[0].pnl > 0);
  assert.ok(rounds[0].pnlPct > 15 && rounds[0].pnlPct < 20, `nhận ${rounds[0].pnlPct}%`);
});

test('số phiên nắm giữ tính từ ngày mua tới ngày bán', () => {
  const rounds = matchSell({
    sell: { tradeId: 9, symbol: 'HOSE:FPT', qty: 100, priceVnd: 60_000, decidedAt: '2026-07-11' },
    openBuys: [{ tradeId: 1, qtyRemaining: 100, priceVnd: 50_000, decidedAt: '2026-07-01' }],
  });
  assert.equal(rounds[0].holdingDays, 10);
});

test('bán nhiều hơn đã mua thì kêu lên, không âm thầm bỏ qua phần dư', () => {
  assert.throws(() => matchSell({
    sell: { tradeId: 9, symbol: 'HOSE:FPT', qty: 500, priceVnd: 60_000, decidedAt: '2026-07-10' },
    openBuys: [{ tradeId: 1, qtyRemaining: 100, priceVnd: 50_000, decidedAt: '2026-07-01' }],
  }), /ghép được/);
});

/* ---------- Ghi vào database ---------- */

test('recordOutcomes ghi vòng đã đóng, bỏ qua vị thế còn mở', async () => {
  await buy('a1', 'HOSE:FPT', 1000, 50_000);
  await sell('a1', 'HOSE:FPT', 1000, 60_000);
  await buy('a1', 'HOSE:VCB', 500, 20_000);      // còn mở, chưa bán

  const r = await recordOutcomes({ repos, agentId: 'a1', logger: silent });
  assert.equal(r.written, 1);

  const list = await repos.trading.listOutcomes('a1');
  assert.equal(list.length, 1);
  assert.equal(list[0].symbol, 'HOSE:FPT');
  assert.ok(list[0].pnl > 0);
});

test('recordOutcomes idempotent — chạy lại không nhân đôi', async () => {
  await buy('a1', 'HOSE:FPT', 1000, 50_000);
  await sell('a1', 'HOSE:FPT', 1000, 60_000);

  await recordOutcomes({ repos, agentId: 'a1', logger: silent });
  const second = await recordOutcomes({ repos, agentId: 'a1', logger: silent });

  assert.equal(second.written, 0);
  assert.equal((await repos.trading.listOutcomes('a1')).length, 1);
});

test('vòng của agent này không lẫn sang agent kia', async () => {
  await buy('a2', 'HOSE:FPT', 1000, 50_000);
  await sell('a2', 'HOSE:FPT', 1000, 60_000);
  await recordOutcomes({ repos, agentId: 'a2', logger: silent });

  assert.equal((await repos.trading.listOutcomes('a1')).length, 0);
  assert.equal((await repos.trading.listOutcomes('a2')).length, 1);
});

/* ---------- Chỉ số ---------- */

test('winRate đếm đúng tỷ lệ lệnh lãi', () => {
  assert.equal(winRate([{ pnl: 1 }, { pnl: -1 }, { pnl: 5 }, { pnl: 0 }]), 0.5);
  assert.equal(winRate([]), null, 'chưa có vòng nào thì không có tỷ lệ, không phải 0');
});

test('sharpe dương khi lợi suất trung bình dương và ổn định', () => {
  const s = sharpe([0.01, 0.012, 0.008, 0.011, 0.009]);
  assert.ok(s > 0, `nhận ${s}`);
});

test('sharpe trả null khi không có biến động — không phải vô cực', () => {
  assert.equal(sharpe([0.01, 0.01, 0.01]), null);
});

test('sharpe trả null khi chưa đủ hai quan sát', () => {
  assert.equal(sharpe([0.01]), null);
  assert.equal(sharpe([]), null);
});

test('sharpe dùng độ lệch chuẩn MẪU, không thổi phồng khi ít phiên', () => {
  const rs = [0.02, -0.01, 0.03];
  const n = rs.length;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sampleSd = Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1));
  const expected = (mean / sampleSd) * Math.sqrt(252);
  assert.ok(Math.abs(sharpe(rs) - expected) < 0.01, `nhận ${sharpe(rs)} kỳ vọng ${expected}`);
});

test('maxDrawdown đo sụt sâu nhất từ ĐỈNH, không phải từ điểm đầu', () => {
  // lên 120 rồi rơi 90 -> sụt 25% từ đỉnh, dù so với điểm đầu chỉ giảm 10%
  assert.equal(maxDrawdown([100, 120, 90, 110]), 25);
});

test('maxDrawdown bằng 0 khi chỉ đi lên', () => {
  assert.equal(maxDrawdown([100, 110, 120]), 0);
});

test('avgHoldingDays trung bình đúng', () => {
  assert.equal(avgHoldingDays([{ holdingDays: 2 }, { holdingDays: 8 }]), 5);
  assert.equal(avgHoldingDays([]), null);
});

test('lessonHitRate tính trên tổng lần truy xuất toàn agent', () => {
  assert.equal(lessonHitRate([
    { timesRetrieved: 10, timesHelped: 6 },
    { timesRetrieved: 10, timesHelped: 2 },
  ]), 0.4);
  assert.equal(lessonHitRate([{ timesRetrieved: 0, timesHelped: 0 }]), null);
});

test('dailyReturns bỏ qua phần tử đầu và tính đúng tỷ lệ', () => {
  assert.deepEqual(dailyReturns([100, 110, 99]).map(r => Math.round(r * 100) / 100), [0.1, -0.1]);
  assert.deepEqual(dailyReturns([100]), []);
});

test('computeAndSaveMetrics lưu lại và đọc được', async () => {
  await buy('a1', 'HOSE:FPT', 1000, 50_000);
  await sell('a1', 'HOSE:FPT', 1000, 60_000);
  await recordOutcomes({ repos, agentId: 'a1', logger: silent });

  await repos.agents.saveSnapshot('a1', '2026-07-29', { cash: 0, marketValue: 0, nav: 1_000_000_000, dayPnl: 0 });
  await repos.agents.saveSnapshot('a1', '2026-07-30', { cash: 0, marketValue: 0, nav: 1_010_000_000, dayPnl: 10_000_000 });

  const m = await computeAndSaveMetrics({ repos, agentId: 'a1', tradeDate: '2026-07-30' });
  assert.equal(m.winRate, 1);
  assert.equal(m.tradeCount, 1);
  assert.equal(m.totalReturnPct, 1);

  const saved = await repos.agents.getMetrics('a1', '2026-07-30');
  assert.equal(saved.winRate, 1);
});

test('chuỗi NAV bỏ mốc 1970 — vốn ban đầu không phải một phiên giao dịch', async () => {
  await repos.agents.saveSnapshot('a1', '2026-07-30', { cash: 0, marketValue: 0, nav: 1_100_000_000, dayPnl: 0 });
  const series = await repos.agents.listNavSeries('a1');
  assert.deepEqual(series, [1_100_000_000]);
});
