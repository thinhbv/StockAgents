import { settlementDate } from './vn_rules.js';

/**
 * Danh mục dựng từ DB. Đây là tầng duy nhất biết cách T+2 tác động lên
 * số lượng bán được: mỗi lần mua tạo một LÔ có ngày về tài khoản riêng,
 * và qty_sellable là tổng các lô đã tới ngày.
 */

export async function loadPortfolio({ repos, agentId, priceMap }) {
  const cash = await repos.agents.getCash(agentId);
  const raw = await repos.trading.getOpenPositions(agentId);

  const positions = raw.map(p => {
    // Thiếu giá thị trường thì dùng giá vốn — cho ra unrealized 0%, không NaN.
    const lastPriceVnd = priceMap.get(p.symbol) ?? p.avgCostVnd;
    const marketValue = Math.round(lastPriceVnd * p.qtyTotal);
    const unrealizedPct = p.avgCostVnd > 0
      ? Math.round(((lastPriceVnd - p.avgCostVnd) / p.avgCostVnd) * 10000) / 100
      : 0;
    return { ...p, lastPriceVnd, marketValue, unrealizedPct };
  });

  const marketValue = positions.reduce((s, p) => s + p.marketValue, 0);
  return { agentId, cash, positions, marketValue, nav: cash + marketValue };
}

/** Mở khoá các lô đã tới ngày về tài khoản. Trả về số vị thế bị thay đổi. */
export async function refreshSellable({ repos, agentId, today }) {
  const positions = await repos.trading.getOpenPositions(agentId);
  let changed = 0;

  for (const p of positions) {
    const lots = await repos.trading.listLots(p.id);
    const sellable = lots
      .filter(l => l.sellableFrom <= today)
      .reduce((s, l) => s + l.qty, 0);

    if (sellable !== p.qtySellable) {
      await repos.trading.upsertPosition(agentId, {
        symbol: p.symbol, qtyTotal: p.qtyTotal, qtySellable: sellable,
        avgCostVnd: p.avgCostVnd, exitPlan: p.exitPlan, peakPriceVnd: p.peakPriceVnd,
      });
      changed++;
    }
  }
  return changed;
}

export async function applyBuy({ repos, agentId, symbol, qty, priceVnd, cost, tradeDate, exitPlan }) {
  const existing = await repos.trading.getPosition(agentId, symbol);

  const qtyTotal = (existing?.qtyTotal ?? 0) + qty;
  const prevCostTotal = (existing?.avgCostVnd ?? 0) * (existing?.qtyTotal ?? 0);
  const avgCostVnd = Math.round((prevCostTotal + priceVnd * qty) / qtyTotal);

  const { id } = await repos.trading.upsertPosition(agentId, {
    symbol,
    qtyTotal,
    qtySellable: existing?.qtySellable ?? 0,   // lô mới chưa về tài khoản
    avgCostVnd,
    exitPlan: exitPlan ?? existing?.exitPlan ?? {},
    peakPriceVnd: Math.max(priceVnd, existing?.peakPriceVnd ?? 0),
  });

  await repos.trading.addLot(id, {
    qty, costVnd: priceVnd, sellableFrom: settlementDate(tradeDate),
  });

  const cash = await repos.agents.getCash(agentId);
  await repos.agents.setCash(agentId, cash - cost);
}

export async function applySell({ repos, agentId, symbol, qty, priceVnd, proceeds }) {
  const p = await repos.trading.getPosition(agentId, symbol);
  if (!p) throw new Error(`applySell: không có vị thế ${symbol} cho ${agentId}`);

  const remaining = p.qtyTotal - qty;
  if (remaining < 0) throw new Error(`applySell: bán ${qty} vượt tồn ${p.qtyTotal}`);

  // Tiêu lô TRƯỚC khi đổi vị thế: lô và vị thế phải luôn khớp nhau, nếu không
  // refreshSellable sẽ mở khoá nhiều hơn số cổ phiếu thực có.
  await repos.trading.consumeLots(p.id, qty);

  if (remaining === 0) {
    await repos.trading.closePosition(agentId, p.id);
  } else {
    await repos.trading.upsertPosition(agentId, {
      symbol, qtyTotal: remaining, qtySellable: p.qtySellable - qty,
      avgCostVnd: p.avgCostVnd, exitPlan: p.exitPlan, peakPriceVnd: p.peakPriceVnd,
    });
  }

  const cash = await repos.agents.getCash(agentId);
  await repos.agents.setCash(agentId, cash + proceeds);
}
