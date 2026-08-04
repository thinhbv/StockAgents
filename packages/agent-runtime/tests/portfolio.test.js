import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo } from '@stockagents/db';
import { loadPortfolio, refreshSellable, applyBuy, applySell } from '../src/sim/portfolio.js';

let client, repos;
const TABLES = ['position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
  'positions', 'portfolio_snapshot', 'metrics_daily', 'agents', 'universe'];

before(async () => {
  client = await withTestDb();
  repos = { agents: createAgentsRepo(client), trading: createTradingRepo(client) };
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE'),('HOSE:VCB','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

test('danh mục rỗng: NAV bằng tiền mặt ban đầu', async () => {
  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map() });
  assert.equal(p.cash, 1_000_000_000);
  assert.equal(p.marketValue, 0);
  assert.equal(p.nav, 1_000_000_000);
  assert.deepEqual(p.positions, []);
});

test('applyBuy trừ tiền, tạo vị thế, và lô CHƯA bán được ngay', async () => {
  await applyBuy({
    repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000,
    priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20',
  });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 100_000]]) });
  assert.equal(p.cash, 899_850_000);
  assert.equal(p.positions.length, 1);
  assert.equal(p.positions[0].qtyTotal, 1000);
  assert.equal(p.positions[0].qtySellable, 0, 'T+2: mua hôm nay chưa bán được');
  assert.equal(p.marketValue, 100_000_000);
});

test('giá vốn trung bình tính đúng khi mua thêm', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 120_000, cost: 120_180_000, tradeDate: '2026-07-21' });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 120_000]]) });
  assert.equal(p.positions[0].qtyTotal, 2000);
  assert.equal(p.positions[0].avgCostVnd, 110_000);
});

test('refreshSellable mở khoá đúng lô đã tới ngày, giữ lô chưa tới', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 500, priceVnd: 100_000, cost: 50_075_000, tradeDate: '2026-07-24' });

  // 2026-07-20 -> bán được từ 2026-07-22; 2026-07-24 -> từ 2026-07-28
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 100_000]]) });
  assert.equal(p.positions[0].qtyTotal, 1500);
  assert.equal(p.positions[0].qtySellable, 1000, 'chỉ lô mua 20/07 đã về tài khoản');
});

test('applySell cộng tiền, giảm vị thế, tiêu lô theo FIFO', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });

  await applySell({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 400, priceVnd: 110_000, proceeds: 43_890_000 });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 110_000]]) });
  assert.equal(p.positions[0].qtyTotal, 600);
  assert.equal(p.positions[0].qtySellable, 600);
  assert.equal(p.cash, 899_850_000 + 43_890_000);

  // Lô phải co lại theo. Nếu không, refreshSellable sau này sẽ mở khoá 1000
  // trong khi chỉ còn 600 cổ phiếu — và bán khống lọt lưới.
  const lots = await repos.trading.listLots(p.positions[0].id);
  assert.equal(lots.reduce((s, l) => s + l.qty, 0), 600, 'tổng lô phải khớp vị thế');
});

test('bán một phần rồi refreshSellable không mở khoá quá số thực có', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });
  await applySell({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 400, priceVnd: 110_000, proceeds: 43_890_000 });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 110_000]]) });
  assert.equal(p.positions[0].qtySellable, 600, 'không được mở khoá quá tồn thực tế');
});

test('bán hết thì vị thế đóng lại, không còn trong danh mục', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });
  await applySell({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 110_000, proceeds: 109_725_000 });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map() });
  assert.deepEqual(p.positions, []);
  assert.equal(p.marketValue, 0);
});

test('unrealizedPct tính theo giá vốn', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 108_000]]) });
  assert.equal(p.positions[0].unrealizedPct, 8);
});

test('thiếu giá thị trường thì dùng giá vốn, không cho ra NaN', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map() });
  assert.equal(p.positions[0].lastPriceVnd, 100_000);
  assert.equal(p.positions[0].unrealizedPct, 0);
  assert.ok(Number.isFinite(p.nav));
});
