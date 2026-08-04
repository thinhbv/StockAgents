import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo } from '@stockagents/db';
import { loadAgentDefs } from '../src/agents/registry.js';
import { buildContext } from '../src/agents/context.js';
import { createRunner } from '../src/agents/runner.js';
import { createStubProvider } from '../src/llm/stub.js';
import { createEngine } from '../src/sim/engine.js';
import { DEFAULT_RISK } from '../src/sim/guardrails.js';

const silent = { info() {}, warn() {}, error() {} };
let client, repos, engine;
const TABLES = ['position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
  'positions', 'portfolio_snapshot', 'metrics_daily', 'agents', 'universe'];

const ctx = () => ({
  tradeDate: '2026-07-20',
  refPriceMap: new Map([['HOSE:FPT', 100_000]]),
  tickPriceMap: new Map([['HOSE:FPT', 100_000]]),
  nav: 1_000_000_000, dayPnl: 0, risk: DEFAULT_RISK,
});

before(async () => {
  client = await withTestDb();
  repos = { agents: createAgentsRepo(client), trading: createTradingRepo(client) };
  engine = createEngine({ repos, logger: silent });
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

test('loadAgentDefs đọc được định nghĩa agent từ config', async () => {
  const defs = await loadAgentDefs();
  assert.ok(defs.length >= 1);
  assert.equal(defs[0].id, 'claude_value');
  assert.ok(defs[0].personaPrompt.length > 50);
});

test('buildContext gói đủ danh mục, universe và ràng buộc', async () => {
  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map([['HOSE:FPT', { rsi14: 62.5, ma20: 98000 }]]),
    priceMap: new Map([['HOSE:FPT', 100_000]]),
    trigger: 'SESSION_OPEN',
  });

  assert.equal(c.trigger, 'SESSION_OPEN');
  assert.equal(c.portfolio.cash, 1_000_000_000);
  assert.equal(c.universe.length, 1);
  assert.equal(c.universe[0].indicators.rsi14, 62.5);
  assert.ok(c.constraints.availableCash > 0);
});

test('buildContext KHÔNG lộ dữ liệu của agent khác', async () => {
  await repos.agents.upsertMany([
    { id: 'a2', name: 'A2', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
  await repos.trading.insertTrade('a2', {
    symbol: 'HOSE:FPT', action: 'BUY', priceVnd: 100000, qty: 100,
    reason: 'bí mật của a2', confidence: 0.9,
  });

  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [], snapshots: new Map(), priceMap: new Map(), trigger: 'SESSION_OPEN',
  });

  assert.equal(JSON.stringify(c).includes('bí mật của a2'), false);
  assert.deepEqual(c.memory.recentTrades, []);
});

test('runOnce nộp quyết định hợp lệ cho engine và khớp lệnh', async () => {
  const provider = createStubProvider({ script: [[{
    action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
    limitPriceVnd: null, confidence: 0.7, reason: 'stub mua thử', exitPlan: {},
  }]] });
  const runner = createRunner({ repos, engine, provider, logger: silent });

  const r = await runner.runOnce({
    agentId: 'a1',
    agentDef: { id: 'a1', personaPrompt: 'p', riskConfig: DEFAULT_RISK },
    context: {}, ctx: ctx(),
  });

  assert.equal(r.results[0].status, 'FILLED');
  assert.equal((await repos.trading.getOpenPositions('a1')).length, 1);
});

test('quyết định sai schema bị bỏ, lượt chạy vẫn hoàn tất', async () => {
  const provider = createStubProvider({ script: [[
    { action: 'YOLO', symbol: 'HOSE:FPT', reason: '' },
    { action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET', limitPriceVnd: null, confidence: 0.7, reason: 'hợp lệ', exitPlan: {} },
  ]] });
  const runner = createRunner({ repos, engine, provider, logger: silent });

  const r = await runner.runOnce({
    agentId: 'a1', agentDef: { id: 'a1', personaPrompt: 'p', riskConfig: DEFAULT_RISK },
    context: {}, ctx: ctx(),
  });

  assert.equal(r.decisions.length, 1, 'chỉ quyết định hợp lệ được giữ');
  assert.equal(r.invalid.length, 1);
  assert.equal(r.results[0].status, 'FILLED');
});

test('provider ném lỗi thì runOnce trả SKIPPED, không sập', async () => {
  const provider = { name: 'boom', async complete() { throw new Error('rate limit'); } };
  const runner = createRunner({ repos, engine, provider, logger: silent });

  const r = await runner.runOnce({
    agentId: 'a1', agentDef: { id: 'a1', personaPrompt: 'p', riskConfig: DEFAULT_RISK },
    context: {}, ctx: ctx(),
  });

  assert.equal(r.status, 'SKIPPED');
  assert.match(r.error, /rate limit/);
});

test('provider trả thứ không phải mảng vẫn xử lý được', async () => {
  const provider = { name: 'weird', async complete() { return { action: 'HOLD', symbol: 'HOSE:FPT', reason: 'một object đơn lẻ', confidence: 0.5 }; } };
  const runner = createRunner({ repos, engine, provider, logger: silent });

  const r = await runner.runOnce({
    agentId: 'a1', agentDef: { id: 'a1', personaPrompt: 'p', riskConfig: DEFAULT_RISK },
    context: {}, ctx: ctx(),
  });
  assert.equal(r.decisions.length, 1);
});
