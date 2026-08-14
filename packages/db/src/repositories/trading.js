import { assertAgentScope } from './_guard.js';

const num = (v) => (v === null || v === undefined ? null : Number(v));
const isoDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

export function createTradingRepo(client) {
  async function insertOrder(agentId, o) {
    const id = assertAgentScope(agentId, 'insertOrder');
    const { rows } = await client.query(
      `INSERT INTO orders (agent_id, symbol, side, qty, order_type, limit_price, status)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING') RETURNING id`,
      [id, o.symbol, o.side, o.qty, o.orderType, o.limitPriceVnd ?? null]);
    return { id: rows[0].id };
  }

  async function rejectOrder(agentId, orderId, reason) {
    const id = assertAgentScope(agentId, 'rejectOrder');
    await client.query(
      `UPDATE orders SET status = 'REJECTED', reject_reason = $3
       WHERE id = $2 AND agent_id = $1`, [id, orderId, String(reason).slice(0, 500)]);
  }

  async function fillOrder(agentId, orderId, { qty, priceVnd, fee, tax }) {
    const id = assertAgentScope(agentId, 'fillOrder');
    return client.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO fills (order_id, agent_id, qty, price, fee, tax)
         VALUES ($1,$2,$3,$4,$5,$6)`, [orderId, id, qty, priceVnd, fee, tax]);
      await tx.query(
        `UPDATE orders SET status = 'FILLED' WHERE id = $1 AND agent_id = $2`,
        [orderId, id]);
    });
  }

  async function listOpenOrders(agentId) {
    const id = assertAgentScope(agentId, 'listOpenOrders');
    const { rows } = await client.query(
      `SELECT id, symbol, side, qty, order_type AS "orderType", limit_price AS "limitPriceVnd"
       FROM orders WHERE agent_id = $1 AND status = 'PENDING' ORDER BY id`, [id]);
    return rows.map(r => ({ ...r, limitPriceVnd: num(r.limitPriceVnd) }));
  }

  async function getOpenPositions(agentId) {
    const id = assertAgentScope(agentId, 'getOpenPositions');
    const { rows } = await client.query(
      `SELECT id, symbol, qty_total AS "qtyTotal", qty_sellable AS "qtySellable",
              avg_cost AS "avgCostVnd", exit_plan AS "exitPlan", peak_price AS "peakPriceVnd",
              opened_at AS "openedAt"
       FROM positions WHERE agent_id = $1 AND closed_at IS NULL ORDER BY symbol`, [id]);
    return rows.map(r => ({ ...r, avgCostVnd: num(r.avgCostVnd), peakPriceVnd: num(r.peakPriceVnd) }));
  }

  async function getPosition(agentId, symbol) {
    const id = assertAgentScope(agentId, 'getPosition');
    const all = await getOpenPositions(id);
    return all.find(p => p.symbol === symbol) ?? null;
  }

  async function upsertPosition(agentId, pos) {
    const id = assertAgentScope(agentId, 'upsertPosition');
    const { rows } = await client.query(
      `INSERT INTO positions (agent_id, symbol, qty_total, qty_sellable, avg_cost, exit_plan, peak_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (agent_id, symbol) WHERE closed_at IS NULL DO UPDATE SET
         qty_total = EXCLUDED.qty_total, qty_sellable = EXCLUDED.qty_sellable,
         avg_cost = EXCLUDED.avg_cost, exit_plan = EXCLUDED.exit_plan,
         peak_price = EXCLUDED.peak_price
       RETURNING id`,
      [id, pos.symbol, pos.qtyTotal, pos.qtySellable, pos.avgCostVnd,
       pos.exitPlan ?? {}, pos.peakPriceVnd ?? null]);
    return { id: rows[0].id };
  }

  async function addLot(positionId, { qty, costVnd, sellableFrom }) {
    await client.query(
      `INSERT INTO position_lots (position_id, qty, cost, sellable_from)
       VALUES ($1,$2,$3,$4)`, [positionId, qty, costVnd, sellableFrom]);
  }

  async function listLots(positionId) {
    const { rows } = await client.query(
      `SELECT id, qty, cost, sellable_from FROM position_lots
       WHERE position_id = $1 ORDER BY sellable_from, id`, [positionId]);
    return rows.map(r => ({
      id: r.id, qty: r.qty, costVnd: num(r.cost), sellableFrom: isoDate(r.sellable_from),
    }));
  }

  /**
   * Tiêu lô theo FIFO khi bán. Không làm việc này thì position_lots sẽ lệch
   * vĩnh viễn với positions: bán 400/1000 mà lô vẫn ghi 1000, và lần
   * refreshSellable sau sẽ mở khoá nhiều hơn số cổ phiếu thực có.
   */
  async function consumeLots(positionId, qty) {
    let left = qty;
    const lots = await listLots(positionId);
    for (const lot of lots) {
      if (left <= 0) break;
      const take = Math.min(left, lot.qty);
      if (take === lot.qty) {
        await client.query('DELETE FROM position_lots WHERE id = $1', [lot.id]);
      } else {
        await client.query('UPDATE position_lots SET qty = qty - $2 WHERE id = $1', [lot.id, take]);
      }
      left -= take;
    }
    if (left > 0) {
      throw new Error(`consumeLots: thiếu ${left} cp trong các lô của vị thế ${positionId}`);
    }
  }

  async function closePosition(agentId, positionId) {
    const id = assertAgentScope(agentId, 'closePosition');
    await client.query(
      `UPDATE positions SET closed_at = now() WHERE id = $2 AND agent_id = $1`,
      [id, positionId]);
  }

  async function insertTrade(agentId, t) {
    const id = assertAgentScope(agentId, 'insertTrade');
    const { rows } = await client.query(
      `INSERT INTO trades (agent_id, symbol, action, price, qty, reason, confidence, trigger, context_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [id, t.symbol, t.action, t.priceVnd, t.qty, t.reason,
       t.confidence ?? null, t.trigger ?? null, t.contextRef ?? {}]);
    return { id: rows[0].id };
  }

  async function listTrades(agentId, limit = 50) {
    const id = assertAgentScope(agentId, 'listTrades');
    const { rows } = await client.query(
      `SELECT id, symbol, action, price, qty, reason, confidence, trigger,
              decided_at AS "decidedAt"
       FROM trades WHERE agent_id = $1 ORDER BY decided_at DESC, id DESC LIMIT $2`,
      [id, limit]);
    return rows.map(r => ({ ...r, priceVnd: num(r.price), confidence: num(r.confidence) }));
  }

  /** Ghi một vòng giao dịch trọn vẹn (mua ghép bán). */
  async function insertOutcome(agentId, r) {
    const id = assertAgentScope(agentId, 'insertOutcome');
    await client.query(
      `INSERT INTO trade_outcomes
         (trade_id, exit_trade_id, agent_id, symbol, qty,
          entry_price, exit_price, pnl, pnl_pct, holding_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (trade_id) DO NOTHING`,
      [r.entryTradeId, r.exitTradeId, id, r.symbol, r.qty,
       r.entryPriceVnd, r.exitPriceVnd, r.pnl, r.pnlPct, r.holdingDays]);
  }

  /** Id các lệnh BÁN đã được ghép — dùng để recordOutcomes idempotent. */
  async function listOutcomeExitIds(agentId) {
    const id = assertAgentScope(agentId, 'listOutcomeExitIds');
    const { rows } = await client.query(
      `SELECT DISTINCT exit_trade_id FROM trade_outcomes WHERE agent_id = $1`, [id]);
    return new Set(rows.map(r => r.exit_trade_id));
  }

  async function listOutcomes(agentId, limit = 500) {
    const id = assertAgentScope(agentId, 'listOutcomes');
    const { rows } = await client.query(
      `SELECT o.trade_id AS "entryTradeId", o.exit_trade_id AS "exitTradeId", o.symbol, o.qty,
              o.entry_price AS "entryPriceVnd", o.exit_price AS "exitPriceVnd",
              o.pnl, o.pnl_pct AS "pnlPct", o.holding_days AS "holdingDays", o.closed_at AS "closedAt",
              t.confidence AS "entryConfidence"
       FROM trade_outcomes o JOIN trades t ON t.id = o.trade_id
       WHERE o.agent_id = $1 ORDER BY o.closed_at DESC LIMIT $2`, [id, limit]);
    return rows.map(r => ({
      ...r, pnl: num(r.pnl), pnlPct: num(r.pnlPct), entryConfidence: num(r.entryConfidence),
      entryPriceVnd: num(r.entryPriceVnd), exitPriceVnd: num(r.exitPriceVnd),
    }));
  }

  return {
    insertOutcome, listOutcomeExitIds, listOutcomes,
    insertOrder, rejectOrder, fillOrder, listOpenOrders,
    getOpenPositions, getPosition, upsertPosition, addLot, listLots, consumeLots,
    closePosition, insertTrade, listTrades,
  };
}
