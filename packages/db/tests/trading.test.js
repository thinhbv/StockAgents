import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo } from '../src/repositories/agents.js';
import { createTradingRepo } from '../src/repositories/trading.js';

let client, agents, trading;
const TABLES = ['position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
  'positions', 'portfolio_snapshot', 'metrics_daily', 'agents', 'universe'];

before(async () => {
  client = await withTestDb();
  agents = createAgentsRepo(client);
  trading = createTradingRepo(client);
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE'),('HOSE:VCB','HOSE')`);
  await agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1000000000 },
    { id: 'a2', name: 'A2', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1000000000 },
  ]);
});
after(async () => { await client.close(); });

test('mọi hàm agent-scoped từ chối khi thiếu agentId', async () => {
  await assert.rejects(() => trading.getOpenPositions(), /agentId/);
  await assert.rejects(() => trading.listTrades(''), /agentId/);
  await assert.rejects(() => agents.getCash(null), /agentId/);
});

test('insertOrder ghi lệnh và trả id', async () => {
  const { id } = await trading.insertOrder('a1', {
    symbol: 'HOSE:FPT', side: 'BUY', qty: 1000, orderType: 'LIMIT', limitPriceVnd: 118500,
  });
  assert.ok(id > 0);
  const open = await trading.listOpenOrders('a1');
  assert.equal(open.length, 1);
  assert.equal(open[0].symbol, 'HOSE:FPT');
});

test('listOpenOrders của agent này không thấy lệnh của agent kia', async () => {
  await trading.insertOrder('a1', { symbol: 'HOSE:FPT', side: 'BUY', qty: 100, orderType: 'MARKET', limitPriceVnd: null });
  await trading.insertOrder('a2', { symbol: 'HOSE:VCB', side: 'BUY', qty: 100, orderType: 'MARKET', limitPriceVnd: null });
  const a1 = await trading.listOpenOrders('a1');
  assert.deepEqual(a1.map(o => o.symbol), ['HOSE:FPT']);
});

test('rejectOrder đổi trạng thái và lưu lý do', async () => {
  const { id } = await trading.insertOrder('a1', { symbol: 'HOSE:FPT', side: 'BUY', qty: 100, orderType: 'MARKET', limitPriceVnd: null });
  await trading.rejectOrder('a1', id, 'không đủ tiền mặt');
  const { rows } = await client.query('SELECT status, reject_reason FROM orders WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'REJECTED');
  assert.equal(rows[0].reject_reason, 'không đủ tiền mặt');
  assert.equal((await trading.listOpenOrders('a1')).length, 0);
});

test('fillOrder ghi fill kèm agent_id khớp order cha', async () => {
  const { id } = await trading.insertOrder('a1', { symbol: 'HOSE:FPT', side: 'BUY', qty: 1000, orderType: 'MARKET', limitPriceVnd: null });
  await trading.fillOrder('a1', id, { qty: 1000, priceVnd: 118500, fee: 177750, tax: 0 });
  const { rows } = await client.query('SELECT agent_id, qty, price FROM fills WHERE order_id = $1', [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, 'a1');
  assert.equal(Number(rows[0].price), 118500);
});

test('vị thế và lô lưu đúng ngày bán được', async () => {
  const pos = await trading.upsertPosition('a1', { symbol: 'HOSE:FPT', qtyTotal: 1000, qtySellable: 0, avgCostVnd: 118500 });
  await trading.addLot(pos.id, { qty: 1000, costVnd: 118500, sellableFrom: '2026-07-22' });
  const lots = await trading.listLots(pos.id);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].sellableFrom, '2026-07-22');
});

test('consumeLots tiêu theo FIFO và báo lỗi khi thiếu', async () => {
  const pos = await trading.upsertPosition('a1', { symbol: 'HOSE:FPT', qtyTotal: 1500, qtySellable: 1500, avgCostVnd: 100000 });
  await trading.addLot(pos.id, { qty: 1000, costVnd: 100000, sellableFrom: '2026-07-22' });
  await trading.addLot(pos.id, { qty: 500, costVnd: 110000, sellableFrom: '2026-07-28' });

  await trading.consumeLots(pos.id, 1200);
  const lots = await trading.listLots(pos.id);
  assert.equal(lots.length, 1, 'lô cũ nhất bị tiêu hết trước');
  assert.equal(lots[0].qty, 300);
  assert.equal(lots[0].sellableFrom, '2026-07-28');

  await assert.rejects(() => trading.consumeLots(pos.id, 999), /thiếu/);
});

test('getOpenPositions chỉ trả vị thế chưa đóng', async () => {
  const pos = await trading.upsertPosition('a1', { symbol: 'HOSE:FPT', qtyTotal: 1000, qtySellable: 0, avgCostVnd: 118500 });
  assert.equal((await trading.getOpenPositions('a1')).length, 1);
  await trading.closePosition('a1', pos.id);
  assert.equal((await trading.getOpenPositions('a1')).length, 0);
});

test('tiền mặt khởi tạo bằng initial_capital và cập nhật được', async () => {
  assert.equal(await agents.getCash('a1'), 1000000000);
  await agents.setCash('a1', 880000000);
  assert.equal(await agents.getCash('a1'), 880000000);
  assert.equal(await agents.getCash('a2'), 1000000000, 'không được đụng agent khác');
});

test('saveSnapshot ghi và ghi đè cùng ngày', async () => {
  await agents.saveSnapshot('a1', '2026-07-20', { cash: 900000000, marketValue: 120000000, nav: 1020000000, dayPnl: 20000000 });
  await agents.saveSnapshot('a1', '2026-07-20', { cash: 880000000, marketValue: 150000000, nav: 1030000000, dayPnl: 30000000 });
  const s = await agents.getSnapshot('a1', '2026-07-20');
  assert.equal(s.nav, 1030000000);
});

test('getPreviousSnapshot lấy phiên trước, không lấy cùng ngày', async () => {
  await agents.saveSnapshot('a1', '2026-07-20', { cash: 900000000, marketValue: 120000000, nav: 1020000000, dayPnl: 20000000 });
  await agents.saveSnapshot('a1', '2026-07-21', { cash: 900000000, marketValue: 130000000, nav: 1030000000, dayPnl: 10000000 });
  assert.equal((await agents.getPreviousSnapshot('a1', '2026-07-21')).nav, 1020000000);
  // Phiên đầu tiên vẫn có mốc: snapshot vốn ban đầu ở 1970-01-01
  assert.equal((await agents.getPreviousSnapshot('a1', '2026-07-20')).nav, 1000000000);
});

test('insertTrade lưu reasoning và đọc lại được theo agent', async () => {
  await trading.insertTrade('a1', {
    symbol: 'HOSE:FPT', action: 'BUY', priceVnd: 118500, qty: 1000,
    reason: 'vượt MA20 với khối lượng lớn', confidence: 0.72, trigger: 'SESSION_OPEN',
  });
  const list = await trading.listTrades('a1', 10);
  assert.equal(list.length, 1);
  assert.match(list[0].reason, /MA20/);
  assert.equal((await trading.listTrades('a2', 10)).length, 0);
});
