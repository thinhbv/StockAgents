import {
  parseSymbol, priceBand, roundToTick, normalizeQty,
  assertPlausibleVndPrice, LOT_SIZE,
} from './vn_rules.js';
import { buyCost, sellProceeds } from './fees.js';
import { checkBuy, checkSell, checkDailyLoss, DEFAULT_RISK } from './guardrails.js';
import { loadPortfolio, applyBuy, applySell } from './portfolio.js';

export const SLIPPAGE_PCT = 0.1;

/**
 * Trọng tài của hệ thống (spec §3.3). Agent chỉ ĐỀ XUẤT; engine kiểm tra
 * luật thị trường, hàng rào rủi ro, rồi mới cho khớp. Mọi lệnh bị từ chối
 * đều được ghi vào orders kèm lý do — đó là dữ liệu học, không phải sự cố.
 */
export function createEngine({ repos, logger = console, slippagePct = SLIPPAGE_PCT }) {

  /** MARKET luôn trượt theo hướng BẤT LỢI cho người đặt lệnh. */
  function slip(priceVnd, side) {
    const factor = side === 'BUY' ? 1 + slippagePct / 100 : 1 - slippagePct / 100;
    return roundToTick(Math.round(priceVnd * factor));
  }

  async function reject(agentId, orderId, reason) {
    if (orderId) await repos.trading.rejectOrder(agentId, orderId, reason);
    return { status: 'REJECTED', orderId, reason };
  }

  async function settleFill(agentId, order, decision, priceVnd, ctx) {
    const { symbol, qty, side } = order;

    if (side === 'BUY') {
      const c = buyCost({ priceVnd, qty });
      await repos.trading.fillOrder(agentId, order.id, { qty, priceVnd, fee: c.fee, tax: 0 });
      await applyBuy({
        repos, agentId, symbol, qty, priceVnd, cost: c.total,
        tradeDate: ctx.tradeDate, exitPlan: decision.exitPlan,
      });
    } else {
      const s = sellProceeds({ priceVnd, qty });
      await repos.trading.fillOrder(agentId, order.id, { qty, priceVnd, fee: s.fee, tax: s.tax });
      await applySell({ repos, agentId, symbol, qty, priceVnd, proceeds: s.net });
    }

    await repos.trading.insertTrade(agentId, {
      symbol, action: side, priceVnd, qty,
      reason: decision.reason, confidence: decision.confidence,
      trigger: decision.trigger ?? null,
    });

    logger.info(`[engine] ${agentId} ${side} ${qty} ${symbol} @ ${priceVnd}`);
    return { status: 'FILLED', orderId: order.id, fillPriceVnd: priceVnd };
  }

  async function submit(agentId, decision, ctx) {
    const risk = ctx.risk ?? DEFAULT_RISK;

    // HOLD không phải lệnh — không ghi gì vào orders.
    if (decision.action === 'HOLD') {
      return { status: 'REJECTED', orderId: null, reason: 'HOLD — không đặt lệnh' };
    }
    if (decision.action !== 'BUY' && decision.action !== 'SELL') {
      return { status: 'REJECTED', orderId: null, reason: `hành động không hợp lệ: ${decision.action}` };
    }

    const side = decision.action;
    const symbol = decision.symbol;

    let exchange;
    try {
      ({ exchange } = parseSymbol(symbol));
    } catch (err) {
      return { status: 'REJECTED', orderId: null, reason: err.message };
    }

    const refPrice = ctx.refPriceMap.get(symbol);
    const tickPrice = ctx.tickPriceMap.get(symbol) ?? refPrice;
    if (!Number.isFinite(refPrice) || !Number.isFinite(tickPrice)) {
      return { status: 'REJECTED', orderId: null, reason: `không có giá cho ${symbol}` };
    }
    try {
      assertPlausibleVndPrice(refPrice, symbol);
    } catch (err) {
      return { status: 'REJECTED', orderId: null, reason: err.message };
    }

    const qty = normalizeQty(Math.trunc(decision.quantity ?? 0));
    if (qty < LOT_SIZE) {
      return { status: 'REJECTED', orderId: null,
        reason: `khối lượng ${decision.quantity} nhỏ hơn một lô chẵn (${LOT_SIZE})` };
    }

    // Ghi lệnh TRƯỚC khi kiểm tra, để lệnh bị từ chối cũng có dấu vết học được.
    const { id: orderId } = await repos.trading.insertOrder(agentId, {
      symbol, side, qty, orderType: decision.orderType ?? 'MARKET',
      limitPriceVnd: decision.limitPriceVnd ?? null,
    });

    const band = priceBand(refPrice, exchange);
    const limit = decision.limitPriceVnd;
    if (decision.orderType === 'LIMIT') {
      if (!Number.isFinite(limit)) return reject(agentId, orderId, 'lệnh LIMIT thiếu giá');
      if (limit < band.floor || limit > band.ceiling) {
        return reject(agentId, orderId,
          `giá ${limit} ngoài biên độ ${exchange} [${band.floor}, ${band.ceiling}]`);
      }
    }

    const portfolio = await loadPortfolio({ repos, agentId, priceMap: ctx.tickPriceMap });

    if (side === 'BUY') {
      // checkDailyLoss CHỈ chặn MUA — mở thêm rủi ro khi đã lỗ nặng trong
      // ngày. Áp dụng cho cả SELL (như trước đây) là một bug: nó khoá luôn
      // đường thoát đúng lúc agent cần cắt lỗ nhất, biến guardrail bảo vệ
      // vốn thành cái nhốt agent trong vị thế thua lỗ — đã thấy thật
      // (gemini_news 2026-10-05: 7 lệnh SELL cắt lỗ FPT/VRE liên tiếp bị từ
      // chối vì "lỗ trong ngày vượt ngưỡng", lỗ chỉ tăng thêm vì không thoát
      // được). checkSell() không có khái niệm giới hạn lỗ ngày, đúng ý định
      // ban đầu đã ghi trong guardrails.js.
      const loss = checkDailyLoss({ dayPnl: ctx.dayPnl, nav: ctx.nav, risk });
      if (!loss.ok) return reject(agentId, orderId, loss.reason);

      const execPrice = decision.orderType === 'LIMIT' ? limit : slip(tickPrice, 'BUY');
      const cost = buyCost({ priceVnd: execPrice, qty }).total;
      const g = checkBuy({
        symbol, costVnd: cost, cash: portfolio.cash, nav: portfolio.nav,
        positions: portfolio.positions, risk,
        indicatorsMissing: ctx.indicatorsMissingSymbols?.has(symbol) ?? false,
      });
      if (!g.ok) return reject(agentId, orderId, g.reason);

      // LIMIT chỉ khớp khi giá thị trường đã chạm tới.
      if (decision.orderType === 'LIMIT' && tickPrice > limit) {
        return { status: 'PENDING', orderId };
      }
      const fillPrice = decision.orderType === 'LIMIT' ? Math.min(limit, tickPrice) : execPrice;
      return settleFill(agentId, { id: orderId, symbol, qty, side }, decision, fillPrice, ctx);
    }

    const g = checkSell({ symbol, qty, positions: portfolio.positions });
    if (!g.ok) return reject(agentId, orderId, g.reason);

    if (decision.orderType === 'LIMIT' && tickPrice < limit) {
      return { status: 'PENDING', orderId };
    }
    const fillPrice = decision.orderType === 'LIMIT'
      ? Math.max(limit, tickPrice)
      : slip(tickPrice, 'SELL');
    return settleFill(agentId, { id: orderId, symbol, qty, side }, decision, fillPrice, ctx);
  }

  /** Đối chiếu các lệnh đang treo với tick mới. Trả về danh sách lệnh vừa khớp. */
  async function matchPending(agentId, ctx) {
    const open = await repos.trading.listOpenOrders(agentId);
    const filled = [];

    for (const o of open) {
      const tickPrice = ctx.tickPriceMap.get(o.symbol);
      if (!Number.isFinite(tickPrice) || !Number.isFinite(o.limitPriceVnd)) continue;

      const touched = o.side === 'BUY'
        ? tickPrice <= o.limitPriceVnd
        : tickPrice >= o.limitPriceVnd;
      if (!touched) continue;

      const fillPrice = o.side === 'BUY'
        ? Math.min(o.limitPriceVnd, tickPrice)
        : Math.max(o.limitPriceVnd, tickPrice);

      const decision = { reason: 'khớp lệnh treo', confidence: null, exitPlan: {} };
      filled.push(await settleFill(agentId, o, decision, fillPrice, ctx));
    }
    return filled;
  }

  return { submit, matchPending };
}
