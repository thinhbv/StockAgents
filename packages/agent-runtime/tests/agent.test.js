import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import {
  createAgentsRepo, createTradingRepo, createNewsRepo, createFundamentalsRepo, createIntradayFlowRepo,
} from '@stockagents/db';
import { loadAgentDefs } from '../src/agents/registry.js';
import { buildContext } from '../src/agents/context.js';
import { createRunner } from '../src/agents/runner.js';
import { createStubProvider } from '../src/llm/stub.js';
import { createEngine } from '../src/sim/engine.js';
import { DEFAULT_RISK } from '../src/sim/guardrails.js';

const silent = { info() {}, warn() {}, error() {} };
let client, repos, engine;
const TABLES = ['position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
  'positions', 'portfolio_snapshot', 'metrics_daily', 'news_items', 'fundamentals_snapshot',
  'intraday_flow_snapshot', 'agents', 'universe'];

const ctx = () => ({
  tradeDate: '2026-07-20',
  refPriceMap: new Map([['HOSE:FPT', 100_000]]),
  tickPriceMap: new Map([['HOSE:FPT', 100_000]]),
  nav: 1_000_000_000, dayPnl: 0, risk: DEFAULT_RISK,
});

before(async () => {
  client = await withTestDb();
  repos = {
    agents: createAgentsRepo(client), trading: createTradingRepo(client),
    news: createNewsRepo(client), fundamentals: createFundamentalsRepo(client),
    intradayFlow: createIntradayFlowRepo(client),
  };
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
  // Trần 20% NAV (mặc định), trừ phí 0,15%, làm tròn lô chẵn 100 — không phải
  // 1000000000/100000=10000cp (sẽ vượt tỷ trọng tối đa một mã).
  assert.equal(c.universe[0].maxAffordableQty, 1900);
});

test('buildContext tính %thay đổi, độ rộng thị trường và sức mạnh ngành từ chính giá đang có — không cần nguồn mới', async () => {
  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [
      { symbol: 'HOSE:FPT', sector: 'Công nghệ' },
      { symbol: 'HOSE:VCB', sector: 'Ngân hàng' },
    ],
    snapshots: new Map(),
    priceMap: new Map([['HOSE:FPT', 110_000], ['HOSE:VCB', 90_000]]),
    refPriceMap: new Map([['HOSE:FPT', 100_000], ['HOSE:VCB', 100_000]]),
  });

  assert.equal(c.universe[0].changePct, 10);
  assert.equal(c.universe[1].changePct, -10);
  assert.equal(c.market.breadth.advancers, 1);
  assert.equal(c.market.breadth.decliners, 1);
  assert.equal(c.market.sectorStrength[0].sector, 'Công nghệ');
  assert.equal(c.market.sectorStrength[0].avgChangePct, 10);
});

test('buildContext = null cho changePct/volumeSpikeRatio khi thiếu giá tham chiếu/chỉ báo khối lượng — không đoán bừa', async () => {
  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map([['HOSE:FPT', { rsi14: 62.5 }]]),
    priceMap: new Map([['HOSE:FPT', 100_000]]),
  });
  assert.equal(c.universe[0].changePct, null);
  assert.equal(c.universe[0].volumeSpikeRatio, null);
  assert.equal(c.market.breadth.advancers, 0);
  assert.deepEqual(c.market.sectorStrength, []);
});

test('buildContext tính volumeSpikeRatio = volume/volumeMa20', async () => {
  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map([['HOSE:FPT', { volume: 3_000_000, volumeMa20: 1_500_000 }]]),
    priceMap: new Map([['HOSE:FPT', 100_000]]),
  });
  assert.equal(c.universe[0].volumeSpikeRatio, 2);
});

test('buildContext tính tỷ trọng/mã trên NAV và %NAV đang lỗ tạm tính', async () => {
  await repos.trading.upsertPosition('a1', {
    symbol: 'HOSE:FPT', qtyTotal: 1000, qtySellable: 1000,
    avgCostVnd: 120_000, exitPlan: {}, peakPriceVnd: 120_000,
  });
  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map(),
    priceMap: new Map([['HOSE:FPT', 100_000]]), // lỗ so với giá vốn 120k
  });
  // nav = cash 1 tỷ (chưa trừ, test dựng thẳng vị thế không qua applyBuy) +
  // marketValue 100tr = 1.1 tỷ. weight = 100tr/1.1tỷ.
  assert.equal(c.portfolio.positions[0].weightPctNav, 9.09);
  assert.equal(c.portfolio.pctNavAtLoss, 9.09);
});

test('buildContext đưa VWAP/áp lực mua-bán gần nhất THẬT vào context, không chỉ mảng rỗng', async () => {
  await repos.intradayFlow.insertSnapshot('HOSE:FPT', { vwapVnd: 71_500, recentBuyVolume: 300, recentSellVolume: 50 });
  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map(), priceMap: new Map([['HOSE:FPT', 100_000]]),
  });
  assert.equal(c.universe[0].intradayFlow.vwapVnd, 71_500);
});

test('buildContext dựng được bình thường khi chưa có snapshot VWAP/repos.intradayFlow vắng mặt — null, không lỗi', async () => {
  const { intradayFlow, ...reposWithoutFlow } = repos;
  const c = await buildContext({
    repos: reposWithoutFlow, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map(), priceMap: new Map([['HOSE:FPT', 100_000]]),
  });
  assert.equal(c.universe[0].intradayFlow, null);
});

test('buildContext đưa tin THẬT (tiêu đề) vào context, không chỉ điểm sentiment', async () => {
  await repos.news.upsertMany([
    { symbol: 'HOSE:FPT', source: 'test', url: 'https://x/1', title: 'FPT trúng thầu dự án lớn',
      summary: 'tóm tắt', sentiment: 0.6, publishedAt: new Date() },
    { symbol: null, source: 'test', url: 'https://x/2', title: 'VN-Index vượt 1300 điểm',
      sentiment: 0.3, publishedAt: new Date() },
  ]);

  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map([['HOSE:FPT', { rsi14: 62.5 }]]),
    priceMap: new Map([['HOSE:FPT', 100_000]]),
  });

  assert.equal(c.universe[0].news.length, 1);
  assert.match(c.universe[0].news[0].title, /trúng thầu/, 'agent phải đọc được tiêu đề thật, không chỉ điểm số');
  assert.equal(c.market.news.length, 1);
  assert.match(c.market.news[0].title, /VN-Index/);
});

test('buildContext dựng được bình thường khi repos.news vắng mặt — news rỗng, không lỗi', async () => {
  const { news, ...reposWithoutNews } = repos;
  const c = await buildContext({
    repos: reposWithoutNews, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map(), priceMap: new Map([['HOSE:FPT', 100_000]]),
  });
  assert.deepEqual(c.universe[0].news, []);
  assert.deepEqual(c.market.news, []);
});

test('buildContext đưa chỉ số cơ bản THẬT (P/E, ROE...) vào context, không chỉ mảng rỗng', async () => {
  await repos.fundamentals.insertSnapshot('HOSE:FPT', { pe: 11.6, roe: 0.26 });
  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map(), priceMap: new Map([['HOSE:FPT', 100_000]]),
  });
  assert.equal(c.universe[0].fundamentals.pe, 11.6);
  assert.equal(c.universe[0].fundamentals.roe, 0.26);
});

test('buildContext dựng được bình thường khi chưa có snapshot cơ bản/repos.fundamentals vắng mặt — null, không lỗi', async () => {
  const { fundamentals, ...reposWithoutFundamentals } = repos;
  const c = await buildContext({
    repos: reposWithoutFundamentals, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map(), priceMap: new Map([['HOSE:FPT', 100_000]]),
  });
  assert.equal(c.universe[0].fundamentals, null);
});

test('maxAffordableQty = 0 khi thiếu giá, không đoán bừa', async () => {
  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map(), priceMap: new Map(), trigger: 'SESSION_OPEN',
  });
  assert.equal(c.universe[0].maxAffordableQty, 0);
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
  const provider = {
    name: 'weird',
    async complete() {
      return {
        decisions: { action: 'HOLD', symbol: 'HOSE:FPT', reason: 'một object đơn lẻ', confidence: 0.5 },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const runner = createRunner({ repos, engine, provider, logger: silent });

  const r = await runner.runOnce({
    agentId: 'a1', agentDef: { id: 'a1', personaPrompt: 'p', riskConfig: DEFAULT_RISK },
    context: {}, ctx: ctx(),
  });
  assert.equal(r.decisions.length, 1);
});
