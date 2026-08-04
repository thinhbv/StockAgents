import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo, createTriggersRepo, createEventsRepo } from '@stockagents/db';
import { createWatchdog } from '../src/orchestrator/watchdog.js';
import { createEngine } from '../src/sim/engine.js';
import { applyBuy, refreshSellable } from '../src/sim/portfolio.js';
import { DEFAULT_RISK } from '../src/sim/guardrails.js';

const silent = { info() {}, warn() {}, error() {} };
let client, repos, engine;
const TABLES = ['trigger_log', 'position_lots', 'fills', 'orders', 'trade_outcomes',
  'trades', 'positions', 'portfolio_snapshot', 'metrics_daily', 'event_log', 'agents', 'universe'];

const agentDef = { id: 'a1', personaPrompt: 'p', riskConfig: DEFAULT_RISK };

function countingRunner(decisions = []) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async runOnce() {
      calls++;
      return { status: 'OK', decisions, invalid: [], results: [] };
    },
  };
}

const base = (over = {}) => ({
  agentId: 'a1', agentDef,
  now: new Date('2026-07-23T10:00:00+07:00'),
  tradeDate: '2026-07-23',
  tickPriceMap: new Map([['HOSE:FPT', 101_000]]),
  refPriceMap: new Map([['HOSE:FPT', 100_000]]),
  newsSentimentMap: new Map(),
  ...over,
});

before(async () => {
  client = await withTestDb();
  repos = {
    agents: createAgentsRepo(client), trading: createTradingRepo(client),
    triggers: createTriggersRepo(client), events: createEventsRepo(client),
  };
  engine = createEngine({ repos, logger: silent });
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
  await applyBuy({
    repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000,
    priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20',
    exitPlan: { takeProfitPct: 8, stopLossPct: -4, trailingPct: 3 },
  });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });
});
after(async () => { await client.close(); });

test('KHÔNG gọi LLM khi giá đi ngang — đây là lý do exitPlan tồn tại', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  const r = await wd.tick(base());

  assert.equal(r.checked, 1);
  assert.deepEqual(r.fired, []);
  assert.equal(r.woken, 0);
  assert.equal(runner.calls, 0, 'giá đi ngang mà vẫn gọi LLM là hỏng cả cơ chế');
});

test('nhiều nhịp giá đi ngang liên tiếp vẫn không tốn lời gọi LLM nào', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  for (let i = 0; i < 12; i++) {
    await wd.tick(base({
      tickPriceMap: new Map([['HOSE:FPT', 100_500 + i * 100]]),
      now: new Date(`2026-07-23T${String(9 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00+07:00`),
    }));
  }
  assert.equal(runner.calls, 0, '12 nhịp đi ngang phải tốn 0 token');
});

test('chạm chốt lời thì đánh thức agent đúng một lần', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  const r = await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 108_000]]) }));

  assert.equal(r.woken, 1);
  assert.equal(runner.calls, 1);
  assert.ok(r.fired.some(t => t.type === 'TAKE_PROFIT'));
});

test('chống rung: nhịp thứ hai trong 30 phút không đánh thức lại', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });
  const hot = new Map([['HOSE:FPT', 108_000]]);

  await wd.tick(base({ tickPriceMap: hot, now: new Date('2026-07-23T10:00:00+07:00') }));
  const second = await wd.tick(base({ tickPriceMap: hot, now: new Date('2026-07-23T10:20:00+07:00') }));

  assert.equal(runner.calls, 1, 'lần hai phải bị chặn');
  assert.ok(second.debounced.some(t => t.type === 'TAKE_PROFIT'));
  assert.equal(second.woken, 0);
});

test('quá 30 phút thì được đánh thức lại', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });
  const hot = new Map([['HOSE:FPT', 108_000]]);

  await wd.tick(base({ tickPriceMap: hot, now: new Date('2026-07-23T10:00:00+07:00') }));
  await wd.tick(base({ tickPriceMap: hot, now: new Date('2026-07-23T10:31:00+07:00') }));

  assert.equal(runner.calls, 2);
});

test('đỉnh giá được cập nhật để trailing hoạt động ở nhịp sau', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 120_000]]) }));
  const pos = await repos.trading.getPosition('a1', 'HOSE:FPT');
  assert.equal(pos.peakPriceVnd, 120_000);

  const r = await wd.tick(base({
    tickPriceMap: new Map([['HOSE:FPT', 116_000]]),
    now: new Date('2026-07-23T11:00:00+07:00'),
  }));
  assert.ok(r.fired.some(t => t.type === 'TRAILING'));
});

test('đỉnh giá không bao giờ đi xuống', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 120_000]]) }));
  await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 90_000]]),
                       now: new Date('2026-07-23T11:00:00+07:00') }));

  const pos = await repos.trading.getPosition('a1', 'HOSE:FPT');
  assert.equal(pos.peakPriceVnd, 120_000);
});

test('tin xấu mạnh đánh thức agent dù giá chưa chạm ngưỡng nào', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  const r = await wd.tick(base({ newsSentimentMap: new Map([['HOSE:FPT', -0.8]]) }));
  assert.ok(r.fired.some(t => t.type === 'NEWS_ALERT'));
  assert.equal(runner.calls, 1);
});

test('mỗi lần trigger nổ đều phát sự kiện đọc được', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 108_000]]) }));

  const events = await repos.events.getEventsSince(0, 50);
  const fired = events.find(e => e.type === 'trigger.fired');
  assert.ok(fired, 'phải có sự kiện trigger.fired');
  assert.equal(fired.agentId, 'a1');
  assert.equal(fired.payload.triggerType, 'TAKE_PROFIT');
});

test('không có vị thế thì không kiểm tra gì và không gọi LLM', async () => {
  await resetTables(client, ['position_lots', 'positions']);
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  const r = await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 108_000]]) }));
  assert.equal(r.checked, 0);
  assert.equal(runner.calls, 0);
});

test('thiếu giá cho mã đang giữ thì bỏ qua mã đó, không đoán bừa', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  const r = await wd.tick(base({ tickPriceMap: new Map() }));
  assert.equal(r.checked, 0);
  assert.equal(runner.calls, 0);
});

test('runner ném lỗi không làm sập watchdog', async () => {
  const runner = { async runOnce() { throw new Error('rate limit'); } };
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  await assert.doesNotReject(() => wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 108_000]]) })));
});

test('agent được đánh thức với NAV thật, không phải 0 — guardrail lỗ ngày phải hoạt động', async () => {
  let seenCtx = null;
  const runner = { async runOnce({ ctx }) { seenCtx = ctx; return { status: 'OK', results: [] }; } };
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 108_000]]) }));

  assert.ok(seenCtx.nav > 900_000_000, `NAV phải là số thật, nhận ${seenCtx.nav}`);
  assert.ok(Number.isFinite(seenCtx.dayPnl));
});
