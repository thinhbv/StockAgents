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

/* ---------- resetAgent ---------- */

test('resetAgent xóa hết vị thế đang giữ và nạp lại đúng vốn ban đầu', async () => {
  const pos = await trading.upsertPosition('a1', { symbol: 'HOSE:FPT', qtyTotal: 1000, qtySellable: 1000, avgCostVnd: 100000 });
  await trading.addLot(pos.id, { qty: 1000, costVnd: 100000, sellableFrom: '2026-07-22' });
  await agents.setCash('a1', 500_000_000); // giả lập đã tiêu bớt tiền mua FPT ở trên

  const r = await trading.resetAgent('a1');

  assert.equal(r.clearedPositions, 1);
  assert.equal(r.cashVnd, 1_000_000_000);
  assert.equal((await trading.getOpenPositions('a1')).length, 0);
  assert.equal(await agents.getCash('a1'), 1_000_000_000);

  const lots = await client.query(`SELECT count(*)::int n FROM position_lots WHERE position_id = $1`, [pos.id]);
  assert.equal(lots.rows[0].n, 0, 'lot của vị thế đã xóa cũng phải biến mất, không mồ côi');
});

test('resetAgent ghi snapshot hôm nay để dashboard (đọc portfolio_snapshot) thấy tiền mới ngay', async () => {
  await client.query(
    `INSERT INTO portfolio_snapshot (agent_id, snap_date, cash, market_value, nav, day_pnl)
     VALUES ('a1', (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 332000000, 1196000000, 1528000000, -7000000)
     ON CONFLICT (agent_id, snap_date) DO UPDATE SET cash = 332000000, nav = 1528000000`);

  await trading.resetAgent('a1');

  const { rows } = await client.query(
    `SELECT cash, market_value, nav, day_pnl FROM portfolio_snapshot
     WHERE agent_id = 'a1' ORDER BY snap_date DESC LIMIT 1`);
  assert.equal(Number(rows[0].cash), 1_000_000_000);
  assert.equal(Number(rows[0].nav), 1_000_000_000);
  assert.equal(Number(rows[0].market_value), 0);
  assert.equal(Number(rows[0].day_pnl), 0);
});

test('resetAgent KHÔNG đụng tới lịch sử đã giao dịch (trades/orders/fills)', async () => {
  await trading.insertTrade('a1', {
    symbol: 'HOSE:FPT', action: 'BUY', priceVnd: 100000, qty: 1000,
    reason: 'test', confidence: 0.7, trigger: 'SESSION_OPEN',
  });
  const { id: orderId } = await trading.insertOrder('a1', { symbol: 'HOSE:FPT', side: 'BUY', qty: 1000, orderType: 'MARKET', limitPriceVnd: null });
  await trading.fillOrder('a1', orderId, { qty: 1000, priceVnd: 100000, fee: 150, tax: 0 });
  const pos = await trading.upsertPosition('a1', { symbol: 'HOSE:FPT', qtyTotal: 1000, qtySellable: 1000, avgCostVnd: 100000 });
  await trading.addLot(pos.id, { qty: 1000, costVnd: 100000, sellableFrom: '2026-07-22' });

  await trading.resetAgent('a1');

  assert.equal((await trading.listTrades('a1', 10)).length, 1, 'trades phải còn nguyên');
  const fills = await client.query(`SELECT count(*)::int n FROM fills WHERE agent_id = 'a1'`);
  assert.equal(fills.rows[0].n, 1, 'fills phải còn nguyên');
  const orders = await client.query(`SELECT count(*)::int n FROM orders WHERE agent_id = 'a1'`);
  assert.equal(orders.rows[0].n, 1, 'orders phải còn nguyên');
});

test('resetAgent không ảnh hưởng tới agent khác — chỉ reset đúng agent được chọn', async () => {
  const pos1 = await trading.upsertPosition('a1', { symbol: 'HOSE:FPT', qtyTotal: 1000, qtySellable: 1000, avgCostVnd: 100000 });
  await trading.addLot(pos1.id, { qty: 1000, costVnd: 100000, sellableFrom: '2026-07-22' });
  const pos2 = await trading.upsertPosition('a2', { symbol: 'HOSE:VCB', qtyTotal: 500, qtySellable: 500, avgCostVnd: 80000 });
  await trading.addLot(pos2.id, { qty: 500, costVnd: 80000, sellableFrom: '2026-07-22' });
  await agents.setCash('a2', 700_000_000);

  await trading.resetAgent('a1');

  assert.equal((await trading.getOpenPositions('a1')).length, 0);
  assert.equal((await trading.getOpenPositions('a2')).length, 1, 'a2 không bị đụng tới');
  assert.equal(await agents.getCash('a2'), 700_000_000, 'tiền của a2 giữ nguyên, không bị nạp lại');
});

test('resetAgent báo lỗi rõ khi agent không tồn tại', async () => {
  await assert.rejects(() => trading.resetAgent('khong-ton-tai'), /không tìm thấy agent/);
});

test('resetAgent trên agent không có vị thế nào vẫn chạy được, chỉ nạp lại tiền', async () => {
  await agents.setCash('a1', 300_000_000);
  const r = await trading.resetAgent('a1');
  assert.equal(r.clearedPositions, 0);
  assert.equal(r.cashVnd, 1_000_000_000);
});
