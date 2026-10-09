import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import {
  createAgentsRepo, createTradingRepo, createOpsRepo, createEventsRepo, createLessonsRepo,
  createMarketRepo,
} from '@stockagents/db';
import { createRoutes } from '../src/routes.js';

let client, repos, routes, tmpDir, agentsConfigPath, modelCatalogPath;
const TABLES = ['lesson_usage', 'lessons', 'trigger_log', 'position_lots', 'fills', 'orders', 'trade_outcomes',
  'trades', 'positions', 'portfolio_snapshot', 'metrics_daily', 'event_log',
  'session_state', 'agents', 'universe'];

const FIXTURE_DEFS = [
  { id: 'a1', name: 'Agent Một', provider: 'stub', model: 'stub',
    personaPrompt: 'kiên nhẫn', initialCapital: 1_000_000_000, riskConfig: { maxPositions: 8 } },
  { id: 'a2', name: 'Agent Hai', provider: 'stub', model: 'stub',
    personaPrompt: 'ngược dòng', initialCapital: 1_000_000_000 },
];
const FIXTURE_CATALOG = { anthropic: ['claude-opus-5', 'claude-sonnet-5'], openai: ['gpt-5'] };

before(async () => {
  client = await withTestDb();
  repos = {
    agents: createAgentsRepo(client), trading: createTradingRepo(client),
    ops: createOpsRepo(client), events: createEventsRepo(client),
    lessons: createLessonsRepo(client), market: createMarketRepo(client),
  };
  tmpDir = await mkdtemp(join(tmpdir(), 'routes-test-'));
  agentsConfigPath = join(tmpDir, 'agents.json');
  modelCatalogPath = join(tmpDir, 'model-catalog.json');
  routes = createRoutes({ client, repos, agentsConfigPath, modelCatalogPath });
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'Agent Một', provider: 'stub', model: 'stub',
      personaPrompt: 'kiên nhẫn', initialCapital: 1_000_000_000,
      riskConfig: { maxPositions: 8 } },
    { id: 'a2', name: 'Agent Hai', provider: 'stub', model: 'stub',
      personaPrompt: 'ngược dòng', initialCapital: 1_000_000_000 },
  ]);
  await writeFile(agentsConfigPath, JSON.stringify(FIXTURE_DEFS, null, 2));
  await writeFile(modelCatalogPath, JSON.stringify(FIXTURE_CATALOG, null, 2));
});
after(async () => {
  await client.close();
  await rm(tmpDir, { recursive: true, force: true });
});

test('GET /api/session trả trạng thái phiên', async () => {
  await repos.ops.setSessionState('2026-07-29', 'DATA_READY', { dataCapturedAt: new Date() });
  const r = await routes.session({ query: { date: '2026-07-29' } });
  assert.equal(r.state, 'DATA_READY');
});

test('GET /api/session không có dữ liệu thì nói rõ, không giả vờ ổn', async () => {
  const r = await routes.session({ query: { date: '2099-01-01' } });
  assert.equal(r.state, 'UNKNOWN');
});

test('GET /api/leaderboard liệt kê mọi agent kèm NAV', async () => {
  await repos.agents.saveSnapshot('a1', '2026-07-29',
    { cash: 900_000_000, marketValue: 150_000_000, nav: 1_050_000_000, dayPnl: 50_000_000 });
  const r = await routes.leaderboard({ query: {} });

  assert.equal(r.agents.length, 2);
  const a1 = r.agents.find(a => a.id === 'a1');
  assert.equal(a1.nav, 1_050_000_000);
  assert.equal(a1.name, 'Agent Một');
  assert.equal(a1.totalReturnPct, 5);
});

test('leaderboard báo isPending khi agents.json lệch với DB sau khi sửa', async () => {
  let r = await routes.leaderboard({ query: {} });
  assert.equal(r.agents.find(a => a.id === 'a1').isPending, false);

  await routes.updateAgentConfig({
    params: { id: 'a1' }, body: { provider: 'anthropic', model: 'claude-sonnet-5' },
  });
  r = await routes.leaderboard({ query: {} });
  const a1 = r.agents.find(a => a.id === 'a1');
  assert.equal(a1.isPending, true);
  assert.equal(a1.model, 'stub', 'bảng vẫn hiện model ĐANG CHẠY THẬT trong DB');
  assert.equal(a1.pendingModel, 'claude-sonnet-5');
});

test('leaderboard sắp theo NAV giảm dần', async () => {
  await repos.agents.saveSnapshot('a1', '2026-07-29', { cash: 0, marketValue: 0, nav: 900_000_000, dayPnl: 0 });
  await repos.agents.saveSnapshot('a2', '2026-07-29', { cash: 0, marketValue: 0, nav: 1_100_000_000, dayPnl: 0 });
  const r = await routes.leaderboard({ query: {} });
  assert.deepEqual(r.agents.map(a => a.id), ['a2', 'a1']);
});

test('GET /api/agents/:id trả cấu hình agent', async () => {
  const r = await routes.agent({ params: { id: 'a1' } });
  assert.equal(r.id, 'a1');
  assert.equal(r.model, 'stub');
  assert.ok(r.personaPrompt.length > 0);
});

test('GET /api/agents/:id với id không tồn tại trả 404', async () => {
  await assert.rejects(() => routes.agent({ params: { id: 'khong-co' } }), /404/);
});

test('GET /api/agents/:id/positions chỉ trả vị thế của agent đó', async () => {
  await repos.trading.upsertPosition('a1',
    { symbol: 'HOSE:FPT', qtyTotal: 1000, qtySellable: 0, avgCostVnd: 100_000,
      exitPlan: { takeProfitPct: 8 } });
  await repos.trading.upsertPosition('a2',
    { symbol: 'HOSE:FPT', qtyTotal: 500, qtySellable: 0, avgCostVnd: 100_000 });

  const r = await routes.positions({ params: { id: 'a1' }, query: {} });
  assert.equal(r.positions.length, 1);
  assert.equal(r.positions[0].qtyTotal, 1000);
  assert.equal(r.positions[0].exitPlan.takeProfitPct, 8);
});

test('GET /api/agents/:id/decisions trả nhật ký lý luận', async () => {
  await repos.trading.insertTrade('a1', {
    symbol: 'HOSE:FPT', action: 'BUY', priceVnd: 100_000, qty: 1000,
    reason: 'vượt MA20 với khối lượng lớn', confidence: 0.72,
  });
  const r = await routes.decisions({ params: { id: 'a1' }, query: { limit: '10' } });
  assert.equal(r.decisions.length, 1);
  assert.match(r.decisions[0].reason, /MA20/);
});

test('decisions của agent này không chứa gì của agent kia', async () => {
  await repos.trading.insertTrade('a2', {
    symbol: 'HOSE:FPT', action: 'BUY', priceVnd: 100_000, qty: 100,
    reason: 'bí mật của a2', confidence: 0.5,
  });
  const r = await routes.decisions({ params: { id: 'a1' }, query: {} });
  assert.equal(JSON.stringify(r).includes('bí mật của a2'), false);
});

test('GET /api/agents/:id/lessons trả bài học của đúng agent đó', async () => {
  await repos.lessons.insert('a1', { lesson: 'tránh mua đuổi khi RSI trên 70', confidence: 0.81 });
  await repos.lessons.insert('a2', { lesson: 'bài của a2', confidence: 0.9 });

  const r = await routes.lessons({ params: { id: 'a1' }, query: {} });
  assert.equal(r.lessons.length, 1);
  assert.match(r.lessons[0].lesson, /RSI/);
  assert.equal(r.lessons[0].confidence, 0.81);
});

test('lessons đã bị loại không xuất hiện trên dashboard', async () => {
  const { id } = await repos.lessons.insert('a1', { lesson: 'mê tín' });
  await repos.lessons.retire('a1', id);
  const r = await routes.lessons({ params: { id: 'a1' }, query: {} });
  assert.deepEqual(r.lessons, []);
});

test('GET /api/events?since= trả sự kiện sau con trỏ', async () => {
  const a = await repos.events.appendEvent({ type: 'e1', payload: {} });
  await repos.events.appendEvent({ type: 'e2', payload: {} });
  const r = await routes.events({ query: { since: String(a.id), limit: '10' } });
  assert.deepEqual(r.events.map(e => e.type), ['e2']);
});

test('GET /api/events chặn limit quá lớn', async () => {
  for (let i = 0; i < 5; i++) await repos.events.appendEvent({ type: `e${i}`, payload: {} });
  const r = await routes.events({ query: { since: '0', limit: '999999' } });
  assert.ok(r.events.length <= 500, 'phải có trần để một lời gọi không kéo cả bảng');
});

test('tham số since không phải số thì coi như 0, không ném lỗi', async () => {
  await repos.events.appendEvent({ type: 'e1', payload: {} });
  const r = await routes.events({ query: { since: 'abc' } });
  assert.equal(r.events.length, 1);
});

/* ---------- Lịch sử NAV cho biểu đồ ---------- */

test('GET /api/agents/:id/history trả chuỗi NAV theo thứ tự thời gian tăng dần', async () => {
  await repos.agents.saveSnapshot('a1', '2026-07-27', { cash: 1e9, marketValue: 0, nav: 1_000_000_000, dayPnl: 0 });
  await repos.agents.saveSnapshot('a1', '2026-07-28', { cash: 9e8, marketValue: 15e7, nav: 1_050_000_000, dayPnl: 50_000_000 });
  await repos.agents.saveSnapshot('a1', '2026-07-29', { cash: 9e8, marketValue: 12e7, nav: 1_020_000_000, dayPnl: -30_000_000 });

  const r = await routes.history({ params: { id: 'a1' }, query: {} });

  assert.deepEqual(r.series.map(p => p.snapDate), ['2026-07-27', '2026-07-28', '2026-07-29'],
    'biểu đồ vẽ trái sang phải nên chuỗi phải cũ trước mới sau');
  assert.deepEqual(r.series.map(p => p.nav), [1_000_000_000, 1_050_000_000, 1_020_000_000]);
  assert.equal(r.initialCapital, 1_000_000_000);
});

test('history có limit thì giữ những ngày MỚI NHẤT, không phải cũ nhất', async () => {
  for (const [d, nav] of [['2026-07-20', 1e9], ['2026-07-21', 11e8], ['2026-07-22', 12e8]]) {
    await repos.agents.saveSnapshot('a1', d, { cash: nav, marketValue: 0, nav, dayPnl: 0 });
  }
  const r = await routes.history({ params: { id: 'a1' }, query: { limit: '2' } });
  assert.deepEqual(r.series.map(p => p.snapDate), ['2026-07-21', '2026-07-22'],
    'cắt bớt phải bỏ ngày cũ, phần người xem quan tâm là gần đây');
});

test('history loại mốc vốn ban đầu 1970 khỏi biểu đồ', async () => {
  await repos.agents.saveSnapshot('a1', '1970-01-01', { cash: 1e9, marketValue: 0, nav: 1_000_000_000, dayPnl: 0 });
  await repos.agents.saveSnapshot('a1', '2026-07-29', { cash: 1e9, marketValue: 0, nav: 1_010_000_000, dayPnl: 1e7 });

  const r = await routes.history({ params: { id: 'a1' }, query: {} });
  assert.deepEqual(r.series.map(p => p.snapDate), ['2026-07-29'],
    'mốc 1970 là bản ghi kỹ thuật, vẽ lên sẽ kéo trục thời gian 56 năm');
});

test('history kèm bộ chỉ số mới nhất', async () => {
  await repos.agents.saveSnapshot('a1', '2026-07-29', { cash: 1e9, marketValue: 0, nav: 1_050_000_000, dayPnl: 0 });
  await repos.agents.saveMetrics('a1', '2026-07-28',
    { totalReturnPct: 2, winRate: 0.4, sharpe: 0.5, maxDrawdown: 3, avgHoldingDays: 2, tradeCount: 5 });
  await repos.agents.saveMetrics('a1', '2026-07-29',
    { totalReturnPct: 5, winRate: 0.6, sharpe: 1.2, maxDrawdown: 4.5, avgHoldingDays: 3, tradeCount: 9 });

  const r = await routes.history({ params: { id: 'a1' }, query: {} });
  assert.equal(r.metrics.snapDate, '2026-07-29');
  assert.equal(r.metrics.winRate, 0.6);
  assert.equal(r.metrics.sharpe, 1.2);
  assert.equal(r.metrics.tradeCount, 9);
});

test('history của agent chưa có phiên nào trả chuỗi rỗng chứ không lỗi', async () => {
  const r = await routes.history({ params: { id: 'a1' }, query: {} });
  assert.deepEqual(r.series, []);
  assert.equal(r.metrics, null);
});

test('history không trộn dữ liệu của agent khác', async () => {
  await repos.agents.saveSnapshot('a2', '2026-07-29', { cash: 0, marketValue: 0, nav: 777_000_000, dayPnl: 0 });
  const r = await routes.history({ params: { id: 'a1' }, query: {} });
  assert.equal(JSON.stringify(r).includes('777000000'), false);
});

test('history với id không tồn tại trả 404', async () => {
  await assert.rejects(() => routes.history({ params: { id: 'khong-co' }, query: {} }), /404/);
});

/* ---------- Cấu hình provider/model của agent ---------- */

test('GET /api/config/catalog trả danh mục provider → model', async () => {
  const r = await routes.modelCatalog();
  assert.deepEqual(r, FIXTURE_CATALOG);
});

test('GET /api/agents/:id/config báo isPending=false khi chưa sửa gì', async () => {
  const r = await routes.agentConfig({ params: { id: 'a1' } });
  assert.equal(r.isPending, false);
  assert.deepEqual(r.active, { provider: 'stub', model: 'stub' });
  assert.deepEqual(r.pending, { provider: 'stub', model: 'stub' });
});

test('GET /api/agents/:id/config báo isPending=true sau khi PATCH, vì DB chưa đổi', async () => {
  await routes.updateAgentConfig({
    params: { id: 'a1' }, body: { provider: 'anthropic', model: 'claude-sonnet-5' },
  });
  const r = await routes.agentConfig({ params: { id: 'a1' } });
  assert.equal(r.isPending, true);
  assert.deepEqual(r.active, { provider: 'stub', model: 'stub' }, 'DB chưa đổi cho tới lần sim:all kế tiếp');
  assert.deepEqual(r.pending, { provider: 'anthropic', model: 'claude-sonnet-5' });
});

test('GET /api/agents/:id/config với id không tồn tại trả 404', async () => {
  await assert.rejects(() => routes.agentConfig({ params: { id: 'khong-co' } }), /404/);
});

test('PATCH /api/agents/:id/config sửa provider/model và ghi lại file JSON', async () => {
  const r = await routes.updateAgentConfig({
    params: { id: 'a1' }, body: { provider: 'anthropic', model: 'claude-sonnet-5' },
  });
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.model, 'claude-sonnet-5');

  const saved = JSON.parse(await readFile(agentsConfigPath, 'utf8'));
  const a1 = saved.find(d => d.id === 'a1');
  assert.equal(a1.provider, 'anthropic');
  assert.equal(a1.model, 'claude-sonnet-5');
  assert.equal(a1.personaPrompt, 'kiên nhẫn', 'các field khác của agent không được đổi');
});

test('PATCH không đổi agent khác trong cùng file', async () => {
  await routes.updateAgentConfig({
    params: { id: 'a1' }, body: { provider: 'anthropic', model: 'claude-sonnet-5' },
  });
  const saved = JSON.parse(await readFile(agentsConfigPath, 'utf8'));
  const a2 = saved.find(d => d.id === 'a2');
  assert.equal(a2.provider, 'stub');
  assert.equal(a2.model, 'stub');
});

test('PATCH agent không tồn tại trả 404', async () => {
  await assert.rejects(() => routes.updateAgentConfig({
    params: { id: 'khong-co' }, body: { provider: 'anthropic', model: 'claude-sonnet-5' },
  }), /404/);
});

test('PATCH provider không có trong danh mục trả 400', async () => {
  await assert.rejects(() => routes.updateAgentConfig({
    params: { id: 'a1' }, body: { provider: 'khong-ton-tai', model: 'x' },
  }), /400/);
});

test('PATCH model không thuộc provider trả 400', async () => {
  await assert.rejects(() => routes.updateAgentConfig({
    params: { id: 'a1' }, body: { provider: 'openai', model: 'claude-sonnet-5' },
  }), /400/);
});

test('PATCH thiếu provider hoặc model trả 400', async () => {
  await assert.rejects(() => routes.updateAgentConfig({
    params: { id: 'a1' }, body: { provider: 'openai' },
  }), /400/);
});

/* ---------- Cấu hình rủi ro của agent (dùng chung cho agent điều phối) ---------- */

test('PATCH /api/agents/:id/risk sửa maxPositionPctNav, giữ nguyên field khác', async () => {
  const r = await routes.updateAgentRisk({ params: { id: 'a1' }, body: { maxPositionPctNav: 15 } });
  assert.equal(r.riskConfig.maxPositionPctNav, 15);

  const saved = JSON.parse(await readFile(agentsConfigPath, 'utf8'));
  const a1 = saved.find(d => d.id === 'a1');
  assert.equal(a1.riskConfig.maxPositionPctNav, 15);
  assert.equal(a1.riskConfig.maxPositions, 8, 'field cũ không liên quan không bị xoá');
});

test('PATCH /api/agents/:id/risk chỉ đổi field được truyền, không xoá field còn lại', async () => {
  await routes.updateAgentRisk({ params: { id: 'a1' }, body: { maxPositionPctNav: 15 } });
  await routes.updateAgentRisk({ params: { id: 'a1' }, body: { dailyLossLimitPct: 3 } });

  const saved = JSON.parse(await readFile(agentsConfigPath, 'utf8'));
  const a1 = saved.find(d => d.id === 'a1');
  assert.equal(a1.riskConfig.maxPositionPctNav, 15, 'lần sửa sau không được xoá lần sửa trước');
  assert.equal(a1.riskConfig.dailyLossLimitPct, 3);
});

test('PATCH /api/agents/:id/risk agent chưa có riskConfig vẫn tạo được', async () => {
  const r = await routes.updateAgentRisk({ params: { id: 'a2' }, body: { dailyLossLimitPct: 4 } });
  assert.equal(r.riskConfig.dailyLossLimitPct, 4);
});

test('PATCH /api/agents/:id/risk thiếu cả hai field trả 400', async () => {
  await assert.rejects(() => routes.updateAgentRisk({ params: { id: 'a1' }, body: {} }), /400/);
});

test('PATCH /api/agents/:id/risk giá trị ngoài (0,100] trả 400', async () => {
  await assert.rejects(() => routes.updateAgentRisk({
    params: { id: 'a1' }, body: { maxPositionPctNav: 0 },
  }), /400/);
  await assert.rejects(() => routes.updateAgentRisk({
    params: { id: 'a1' }, body: { dailyLossLimitPct: 150 },
  }), /400/);
});

test('PATCH /api/agents/:id/risk agent không tồn tại trả 404', async () => {
  await assert.rejects(() => routes.updateAgentRisk({
    params: { id: 'khong-co' }, body: { maxPositionPctNav: 10 },
  }), /404/);
});

/* ---------- POST /api/agents/:id/reset ---------- */

// runScriptImpl được tiêm vào thay vì gọi cli_reset.js thật qua spawn — route
// này chỉ có nhiệm vụ kiểm tra agent tồn tại rồi giao việc GHI DB thật cho
// tiến trình con (client của route vẫn chỉ đọc, xem comment trong routes.js).
test('POST /api/agents/:id/reset trả 404 khi agent không tồn tại — KHÔNG gọi script', async () => {
  let called = false;
  const r = createRoutes({
    client, repos, agentsConfigPath, modelCatalogPath,
    runScriptImpl: async () => { called = true; return '{}'; },
  });
  await assert.rejects(() => r.resetAgent({ params: { id: 'khong-co' } }), /404/);
  assert.equal(called, false, 'agent không tồn tại thì không được spawn tiến trình con');
});

test('POST /api/agents/:id/reset trả đúng kết quả JSON từ script con', async () => {
  const r = createRoutes({
    client, repos, agentsConfigPath, modelCatalogPath,
    runScriptImpl: async (script, args) => {
      assert.equal(script, 'agent:reset');
      assert.deepEqual(args, ['--agent', 'a1']);
      return '> stockagents@0.1.0 agent:reset\n> node packages/agent-runtime/src/cli_reset.js --agent a1\n\n'
        + '{"agentId":"a1","clearedPositions":3,"cashVnd":1000000000}\n';
    },
  });
  const result = await r.resetAgent({ params: { id: 'a1' } });
  assert.deepEqual(result, { agentId: 'a1', clearedPositions: 3, cashVnd: 1_000_000_000 });
});

test('POST /api/agents/:id/reset báo 500 kèm lý do khi script con thất bại', async () => {
  const r = createRoutes({
    client, repos, agentsConfigPath, modelCatalogPath,
    runScriptImpl: async () => { throw new Error('resetAgent: không tìm thấy agent a1'); },
  });
  await assert.rejects(() => r.resetAgent({ params: { id: 'a1' } }), /500.*không tìm thấy agent/);
});

test('POST /api/agents/:id/reset báo 500 khi script con không trả JSON hợp lệ', async () => {
  const r = createRoutes({
    client, repos, agentsConfigPath, modelCatalogPath,
    runScriptImpl: async () => 'không có json nào ở đây\n',
  });
  await assert.rejects(() => r.resetAgent({ params: { id: 'a1' } }), /500/);
});
