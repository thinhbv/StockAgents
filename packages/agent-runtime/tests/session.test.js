import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo } from '@stockagents/db';
import { runSession } from '../src/session.js';
import { createStubProvider } from '../src/llm/stub.js';

const silent = { info() {}, warn() {}, error() {} };
let client, agentsRepo;
const TABLES = ['position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
  'positions', 'portfolio_snapshot', 'metrics_daily',
  'indicator_snapshot', 'quote_tick', 'ohlcv_daily', 'agents', 'universe'];

before(async () => {
  client = await withTestDb();
  agentsRepo = createAgentsRepo(client);
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange, sector) VALUES ('HOSE:FPT','HOSE','Công nghệ')`);
  await client.query(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
                      VALUES ('HOSE:FPT','2026-07-17', 99000, 101000, 98000, 100000, 1000000)`);
  await client.query(`INSERT INTO quote_tick (symbol, price, volume) VALUES ('HOSE:FPT', 100000, 5000)`);
  await client.query(`INSERT INTO indicator_snapshot (symbol, payload) VALUES ('HOSE:FPT', '{"rsi14":62.5}')`);
  await agentsRepo.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

test('phiên chạy trọn vẹn với stub HOLD: không lệnh, có snapshot', async () => {
  const r = await runSession({
    client, agentId: 'a1', tradeDate: '2026-07-20',
    provider: createStubProvider({}), logger: silent,
  });

  assert.equal(r.results.length, 1, 'HOLD vẫn là một quyết định được xử lý');
  assert.equal(r.results[0].status, 'REJECTED');
  assert.equal(r.close.nav, 1_000_000_000);
  assert.ok(await agentsRepo.getSnapshot('a1', '2026-07-20'));
});

test('phiên với quyết định MUA: vị thế hình thành, NAV phản ánh phí', async () => {
  const provider = createStubProvider({ script: [[{
    action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
    limitPriceVnd: null, confidence: 0.7, reason: 'stub mua', exitPlan: { takeProfitPct: 8, stopLossPct: -4 },
  }]] });

  const r = await runSession({ client, agentId: 'a1', tradeDate: '2026-07-20', provider, logger: silent });

  assert.equal(r.results[0].status, 'FILLED');
  assert.ok(r.close.nav < 1_000_000_000, 'phí làm NAV giảm khi giá đứng yên');
  assert.ok(r.close.marketValue > 0);
});

test('giá được chuyển sang VND đúng đơn vị', async () => {
  const provider = createStubProvider({ script: [[{
    action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
    limitPriceVnd: null, confidence: 0.7, reason: 'kiểm tra đơn vị', exitPlan: {},
  }]] });

  const r = await runSession({ client, agentId: 'a1', tradeDate: '2026-07-20', provider, logger: silent });

  // quote 100 (nghìn đồng) -> 100.000 VND; 1000 cp -> ~100 triệu, không phải 100 nghìn
  assert.ok(r.close.marketValue > 90_000_000 && r.close.marketValue < 110_000_000,
    `giá trị thị trường ${r.close.marketValue} sai đơn vị`);
});

test('exitPlan của agent được lưu lại cho Phase 3 đọc', async () => {
  const provider = createStubProvider({ script: [[{
    action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
    limitPriceVnd: null, confidence: 0.7, reason: 'có kế hoạch thoát',
    exitPlan: { takeProfitPct: 8, stopLossPct: -4, timeStopDays: 10 },
  }]] });

  await runSession({ client, agentId: 'a1', tradeDate: '2026-07-20', provider, logger: silent });

  const { rows } = await client.query(
    `SELECT exit_plan FROM positions WHERE agent_id='a1' AND closed_at IS NULL`);
  assert.equal(rows[0].exit_plan.takeProfitPct, 8);
  assert.equal(rows[0].exit_plan.stopLossPct, -4);
});

test('chạy lại cùng ngày không nhân đôi snapshot', async () => {
  await runSession({ client, agentId: 'a1', tradeDate: '2026-07-20', provider: createStubProvider({}), logger: silent });
  await runSession({ client, agentId: 'a1', tradeDate: '2026-07-20', provider: createStubProvider({}), logger: silent });

  const { rows } = await client.query(
    `SELECT count(*)::int n FROM portfolio_snapshot WHERE agent_id='a1' AND snap_date='2026-07-20'`);
  assert.equal(rows[0].n, 1);
});

test('không có dữ liệu giá thì phiên dừng sớm, không đoán bừa', async () => {
  await client.query('TRUNCATE quote_tick, ohlcv_daily CASCADE');
  const r = await runSession({
    client, agentId: 'a1', tradeDate: '2026-07-20',
    provider: createStubProvider({}), logger: silent,
  });
  assert.equal(r.status, 'NO_DATA');
  assert.equal(r.results.length, 0);
});
