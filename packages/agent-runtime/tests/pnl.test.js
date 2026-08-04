import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo } from '@stockagents/db';
import { applyBuy } from '../src/sim/portfolio.js';
import { closeSession } from '../src/sim/pnl.js';

let client, repos;
const TABLES = ['position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
  'positions', 'portfolio_snapshot', 'metrics_daily', 'agents', 'universe'];

before(async () => {
  client = await withTestDb();
  repos = { agents: createAgentsRepo(client), trading: createTradingRepo(client) };
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

test('phiên không giao dịch: NAV giữ nguyên, PnL bằng 0', async () => {
  const r = await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map() });
  assert.equal(r.nav, 1_000_000_000);
  assert.equal(r.dayPnl, 0);
  assert.equal(r.totalReturnPct, 0);
});

test('giá tăng làm NAV tăng, PnL ngày dương', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  const r = await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map([['HOSE:FPT', 110_000]]) });

  // tiền 899.850.000 + giá trị 110.000.000 = 1.009.850.000
  assert.equal(r.nav, 1_009_850_000);
  assert.equal(r.dayPnl, 9_850_000);
  assert.ok(r.totalReturnPct > 0.9 && r.totalReturnPct < 1.0);
});

test('phí giao dịch làm NAV giảm khi giá đứng yên', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  const r = await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map([['HOSE:FPT', 100_000]]) });

  assert.equal(r.dayPnl, -150_000, 'đúng bằng phí mua');
});

test('PnL ngày tính so với snapshot phiên TRƯỚC, không phải vốn ban đầu', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map([['HOSE:FPT', 110_000]]) });

  const r2 = await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-21', priceMap: new Map([['HOSE:FPT', 115_000]]) });
  assert.equal(r2.dayPnl, 5_000_000, 'chỉ phần tăng so với hôm trước');
});

test('closeSession lưu snapshot đọc lại được', async () => {
  await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map() });
  const s = await repos.agents.getSnapshot('a1', '2026-07-20');
  assert.equal(s.nav, 1_000_000_000);
});

test('chạy lại cùng ngày ghi đè, không nhân đôi và không làm PnL về 0', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  const first = await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map([['HOSE:FPT', 110_000]]) });
  const second = await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map([['HOSE:FPT', 110_000]]) });

  const { rows } = await client.query(
    `SELECT count(*)::int n FROM portfolio_snapshot WHERE agent_id='a1' AND snap_date='2026-07-20'`);
  assert.equal(rows[0].n, 1);
  assert.equal(second.dayPnl, first.dayPnl, 'mốc so sánh vẫn là phiên trước, không phải chính nó');
});
