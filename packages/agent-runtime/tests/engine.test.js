import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo } from '@stockagents/db';
import { createEngine } from '../src/sim/engine.js';
import { loadPortfolio, refreshSellable, applyBuy } from '../src/sim/portfolio.js';
import { DEFAULT_RISK } from '../src/sim/guardrails.js';

const silent = { info() {}, warn() {}, error() {} };
let client, repos, engine;
const TABLES = ['position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
  'positions', 'portfolio_snapshot', 'metrics_daily', 'agents', 'universe'];

const ctx = (over = {}) => ({
  tradeDate: '2026-07-20',
  refPriceMap: new Map([['HOSE:FPT', 100_000]]),
  tickPriceMap: new Map([['HOSE:FPT', 100_000]]),
  nav: 1_000_000_000,
  dayPnl: 0,
  risk: DEFAULT_RISK,
  ...over,
});

const buy = (over = {}) => ({
  action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
  limitPriceVnd: null, reason: 'test', confidence: 0.6, exitPlan: {}, ...over,
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

test('lệnh MARKET hợp lệ khớp ngay và trừ tiền', async () => {
  const r = await engine.submit('a1', buy(), ctx());
  assert.equal(r.status, 'FILLED');

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: ctx().tickPriceMap });
  assert.equal(p.positions[0].qtyTotal, 1000);
  assert.ok(p.cash < 1_000_000_000);
});

test('MARKET mua chịu trượt giá bất lợi', async () => {
  const r = await engine.submit('a1', buy(), ctx());
  assert.ok(r.fillPriceVnd > 100_000, `mua phải trượt lên, nhận ${r.fillPriceVnd}`);
});

test('khối lượng lẻ bị làm tròn xuống bội 100', async () => {
  const r = await engine.submit('a1', buy({ quantity: 1099 }), ctx());
  assert.equal(r.status, 'FILLED');
  const { rows } = await client.query(`SELECT qty FROM orders WHERE agent_id='a1'`);
  assert.equal(rows[0].qty, 1000);
});

test('khối lượng dưới một lô bị từ chối', async () => {
  const r = await engine.submit('a1', buy({ quantity: 50 }), ctx());
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /lô chẵn|100/);
});

test('lệnh LIMIT ngoài biên độ bị từ chối và ghi lý do vào DB', async () => {
  const r = await engine.submit('a1',
    buy({ orderType: 'LIMIT', limitPriceVnd: 120_000 }), ctx());
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /biên độ/);

  const { rows } = await client.query(`SELECT status, reject_reason FROM orders WHERE agent_id='a1'`);
  assert.equal(rows[0].status, 'REJECTED');
  assert.match(rows[0].reject_reason, /biên độ/);
});

test('LIMIT chưa chạm giá thì treo, chưa khớp', async () => {
  const r = await engine.submit('a1',
    buy({ orderType: 'LIMIT', limitPriceVnd: 95_000 }),
    ctx({ tickPriceMap: new Map([['HOSE:FPT', 100_000]]) }));
  assert.equal(r.status, 'PENDING');
  assert.equal((await repos.trading.getOpenPositions('a1')).length, 0);
});

test('matchPending khớp lệnh LIMIT khi giá chạm ở tick sau', async () => {
  await engine.submit('a1', buy({ orderType: 'LIMIT', limitPriceVnd: 95_000 }), ctx());
  const filled = await engine.matchPending('a1',
    ctx({ tickPriceMap: new Map([['HOSE:FPT', 94_500]]) }));

  assert.equal(filled.length, 1);
  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 94_500]]) });
  assert.equal(p.positions[0].qtyTotal, 1000);
});

test('mua vượt tiền mặt bị từ chối, không tạo vị thế', async () => {
  const r = await engine.submit('a1', buy({ quantity: 20_000 }), ctx());
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /tiền mặt|tỷ trọng/);
  assert.equal((await repos.trading.getOpenPositions('a1')).length, 0);
});

test('bán cổ phiếu mua cùng ngày bị từ chối theo T+2', async () => {
  await engine.submit('a1', buy(), ctx());
  const r = await engine.submit('a1',
    { action: 'SELL', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET', limitPriceVnd: null, reason: 'x', confidence: 0.5 },
    ctx());

  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /T\+2|bán được/);
});

test('bán được sau khi lô đã về tài khoản, tiền tăng lên', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });

  const before = await repos.agents.getCash('a1');
  const r = await engine.submit('a1',
    { action: 'SELL', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET', limitPriceVnd: null, reason: 'chốt lời', confidence: 0.8 },
    ctx({ tradeDate: '2026-07-23' }));

  assert.equal(r.status, 'FILLED');
  assert.ok(await repos.agents.getCash('a1') > before);
});

test('MARKET bán chịu trượt giá bất lợi (xuống)', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });

  const r = await engine.submit('a1',
    { action: 'SELL', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET', limitPriceVnd: null, reason: 'x', confidence: 0.5 },
    ctx({ tradeDate: '2026-07-23' }));
  assert.ok(r.fillPriceVnd < 100_000, `bán phải trượt xuống, nhận ${r.fillPriceVnd}`);
});

test('HOLD không tạo lệnh nào', async () => {
  const r = await engine.submit('a1', { action: 'HOLD', symbol: 'HOSE:FPT', reason: 'chờ thêm' }, ctx());
  assert.equal(r.status, 'REJECTED');
  const { rows } = await client.query(`SELECT count(*)::int n FROM orders WHERE agent_id='a1'`);
  assert.equal(rows[0].n, 0, 'HOLD không được ghi lệnh');
});

test('chặn MUA khi lỗ ngày vượt ngưỡng', async () => {
  const r = await engine.submit('a1', buy(), ctx({ dayPnl: -60_000_000 }));
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /lỗ trong ngày/);
});

// Bug thật đã gặp (gemini_news 2026-10-05): lỗ ngày vượt ngưỡng chặn luôn
// lệnh BÁN cắt lỗ — đúng lúc cần thoát vị thế nhất lại bị khoá, lỗ càng
// tăng vì không bán được. checkDailyLoss chỉ được áp cho BUY (guardrails.js
// đã ghi rõ ý định này), SELL không bao giờ bị chặn vì lý do lỗ ngày.
test('KHÔNG chặn BÁN khi lỗ ngày vượt ngưỡng — cắt lỗ phải luôn thực hiện được', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });

  const r = await engine.submit('a1',
    { action: 'SELL', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET', limitPriceVnd: null, reason: 'cắt lỗ', confidence: 0.5 },
    ctx({ tradeDate: '2026-07-23', dayPnl: -60_000_000 }));
  assert.equal(r.status, 'FILLED', `lệnh bán cắt lỗ không được bị chặn, nhận: ${r.reason ?? r.status}`);
});

test('mọi lệnh khớp đều ghi trades kèm reasoning', async () => {
  await engine.submit('a1', buy({ reason: 'vượt kháng cự 100' }), ctx());
  const trades = await repos.trading.listTrades('a1', 10);
  assert.equal(trades.length, 1);
  assert.match(trades[0].reason, /kháng cự/);
});

test('thiếu giá tham chiếu thì từ chối, không đoán bừa', async () => {
  const r = await engine.submit('a1', buy({ symbol: 'HOSE:FPT' }),
    ctx({ refPriceMap: new Map(), tickPriceMap: new Map() }));
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /giá/);
});
