import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createOpsRepo, createEventsRepo } from '@stockagents/db';
import { createOrchestrator } from '../src/orchestrator/session.js';
import { createStubProvider } from '../src/llm/stub.js';
import { DEFAULT_RISK } from '../src/sim/guardrails.js';

const silent = { info() {}, warn() {}, error() {} };
let client, agentsRepo, opsRepo, eventsRepo;
const TABLES = ['trigger_log', 'position_lots', 'fills', 'orders', 'trade_outcomes',
  'trades', 'positions', 'portfolio_snapshot', 'metrics_daily', 'event_log',
  'indicator_snapshot', 'quote_tick', 'ohlcv_daily', 'session_state', 'agents', 'universe'];

const agentDef = {
  id: 'a1', name: 'A1', provider: 'stub', model: 'stub',
  personaPrompt: 'p', initialCapital: 1_000_000_000, riskConfig: DEFAULT_RISK,
};

const buyThenHold = () => createStubProvider({ script: [
  [{ action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
     limitPriceVnd: null, confidence: 0.7, reason: 'mở vị thế',
     exitPlan: { takeProfitPct: 8, stopLossPct: -4 } }],
  [{ action: 'HOLD', symbol: 'HOSE:FPT', reason: 'giữ tiếp', confidence: 0.5 }],
] });

before(async () => {
  client = await withTestDb();
  agentsRepo = createAgentsRepo(client);
  opsRepo = createOpsRepo(client);
  eventsRepo = createEventsRepo(client);
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange, sector) VALUES ('HOSE:FPT','HOSE','Công nghệ')`);
  await client.query(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
                      VALUES ('HOSE:FPT','2026-07-22', 99000, 101000, 98000, 100000, 1000000)`);
  await client.query(`INSERT INTO quote_tick (symbol, price, volume) VALUES ('HOSE:FPT', 100000, 5000)`);
  await client.query(`INSERT INTO indicator_snapshot (symbol, payload) VALUES ('HOSE:FPT', '{"rsi14":55}')`);
  await opsRepo.setSessionState('2026-07-23', 'DATA_READY', { dataCapturedAt: new Date() });
  await agentsRepo.upsertMany([agentDef]);
});
after(async () => { await client.close(); });

test('phiên đầy đủ: mở cửa mua, theo dõi, chốt phiên', async () => {
  const orch = createOrchestrator({ client, logger: silent });

  const r = await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(),
    ticks: [
      { at: new Date('2026-07-23T09:30:00+07:00'), prices: new Map([['HOSE:FPT', 101000]]) },
      { at: new Date('2026-07-23T10:00:00+07:00'), prices: new Map([['HOSE:FPT', 102000]]) },
    ],
  });

  assert.equal(r.state, 'IDLE');
  assert.equal(r.open.results[0].status, 'FILLED');
  assert.equal(r.watch.length, 2);
  assert.ok(r.close.nav > 0);
});

test('DATA_STALE thì KHÔNG mở phiên — thà không trade còn hơn trade mù', async () => {
  await opsRepo.setSessionState('2026-07-23', 'DATA_STALE', { note: 'mất CDP' });
  const orch = createOrchestrator({ client, logger: silent });

  const r = await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(), ticks: [],
  });

  assert.equal(r.state, 'PRE_OPEN');
  assert.equal(r.open, null);
  assert.equal(r.close, null);
});

test('không có session_state cho ngày đó cũng không mở phiên', async () => {
  const orch = createOrchestrator({ client, logger: silent });
  const r = await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-24', provider: buyThenHold(), ticks: [],
  });
  assert.equal(r.state, 'PRE_OPEN');
  assert.equal(r.dataState, 'DATA_STALE');
});

test('DATA_PARTIAL vẫn mở phiên nhưng có cảnh báo trong sự kiện', async () => {
  await opsRepo.setSessionState('2026-07-23', 'DATA_PARTIAL', { note: '1/30 mã lỗi' });
  const orch = createOrchestrator({ client, logger: silent });

  const r = await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(), ticks: [],
  });

  assert.equal(r.state, 'IDLE');
  const events = await eventsRepo.getEventsSince(0, 50);
  const st = events.filter(e => e.type === 'session.state');
  assert.ok(st.some(e => e.payload.dataState === 'DATA_PARTIAL'));
});

test('chạm chốt lời trong phiên thì watchdog đánh thức agent', async () => {
  const provider = createStubProvider({ script: [
    [{ action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
       limitPriceVnd: null, confidence: 0.7, reason: 'mở vị thế',
       exitPlan: { takeProfitPct: 8, stopLossPct: -4 } }],
    [{ action: 'SELL', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
       limitPriceVnd: null, confidence: 0.9, reason: 'chốt lời theo kế hoạch' }],
  ] });
  const orch = createOrchestrator({ client, logger: silent });

  const r = await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider,
    ticks: [
      // Mở phiên ở 100, rồi tăng lên 110 (+~9,8% so với giá vốn) -> chốt lời.
      { at: new Date('2026-07-23T09:30:00+07:00'), prices: new Map([['HOSE:FPT', 100000]]) },
      { at: new Date('2026-07-23T10:00:00+07:00'), prices: new Map([['HOSE:FPT', 110000]]) },
    ],
  });

  assert.equal(r.watch[0].woken, 0, 'nhịp mở cửa chưa lãi thì không tốn LLM');
  assert.equal(r.watch[1].woken, 1);
  assert.ok(r.watch[1].fired.some(t => t.type === 'TAKE_PROFIT'));
});

test('giá mở cửa lấy từ tick ĐẦU ngày, không phải tick mới nhất', async () => {
  const orch = createOrchestrator({ client, logger: silent });
  const r = await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(),
    ticks: [
      { at: new Date('2026-07-23T09:30:00+07:00'), prices: new Map([['HOSE:FPT', 100000]]) },
      { at: new Date('2026-07-23T14:00:00+07:00'), prices: new Map([['HOSE:FPT', 130000]]) },
    ],
  });

  // Mua ở ~100.000 + trượt giá, KHÔNG phải ở 130.000 của cuối ngày.
  const fill = r.open.results[0].fillPriceVnd;
  assert.ok(fill > 100_000 && fill < 102_000,
    `giá khớp mở cửa ${fill} phải quanh 100.000, không phải giá cuối ngày`);
});

test('phát sự kiện chuyển trạng thái theo đúng thứ tự', async () => {
  const orch = createOrchestrator({ client, logger: silent });
  await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(), ticks: [],
  });

  const events = await eventsRepo.getEventsSince(0, 50);
  const states = events.filter(e => e.type === 'session.state').map(e => e.payload.state);
  assert.deepEqual(states, ['PRE_OPEN', 'OPEN', 'WATCHING', 'CLOSING', 'LEARNING', 'IDLE']);
});

test('chạy lại cùng ngày không nhân đôi snapshot', async () => {
  const orch = createOrchestrator({ client, logger: silent });
  await orch.runDay({ agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(), ticks: [] });
  await orch.runDay({ agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(), ticks: [] });

  const { rows } = await client.query(
    `SELECT count(*)::int n FROM portfolio_snapshot WHERE agent_id='a1' AND snap_date='2026-07-23'`);
  assert.equal(rows[0].n, 1);
});
