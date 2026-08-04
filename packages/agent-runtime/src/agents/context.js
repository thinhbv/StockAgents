import { loadPortfolio } from '../sim/portfolio.js';
import { DEFAULT_RISK } from '../sim/guardrails.js';
import { retrieveLessons } from '../memory/retrieval.js';

/**
 * Dựng context đưa cho agent.
 *
 * MỌI truy vấn dữ liệu agent đều đi qua repository có assertAgentScope,
 * nên context của agent này không thể chứa dữ liệu của agent khác (spec §3.2).
 */
export async function buildContext({
  repos, agentId, tradeDate, universe, snapshots, priceMap,
  trigger = 'SESSION_OPEN', risk = DEFAULT_RISK, picksPerSession = 5, queryVector,
}) {
  const portfolio = await loadPortfolio({ repos, agentId, priceMap });
  const recentTrades = await repos.trading.listTrades(agentId, 20);

  // Bài học chỉ có nếu Phase 6 đã bật; thiếu repo thì context vẫn dựng được.
  const lessons = repos.lessons
    ? await retrieveLessons({ repos, agentId, queryVector })
    : [];

  return {
    asOf: tradeDate,
    trigger,
    universe: universe.map(u => ({
      symbol: u.symbol,
      sector: u.sector ?? null,
      lastPriceVnd: priceMap.get(u.symbol) ?? null,
      indicators: snapshots.get(u.symbol) ?? {},
    })),
    portfolio: {
      cash: portfolio.cash,
      nav: portfolio.nav,
      positions: portfolio.positions.map(p => ({
        symbol: p.symbol, qtyTotal: p.qtyTotal, qtySellable: p.qtySellable,
        avgCostVnd: p.avgCostVnd, unrealizedPct: p.unrealizedPct, exitPlan: p.exitPlan,
      })),
    },
    memory: {
      recentTrades: recentTrades.map(t => ({
        symbol: t.symbol, action: t.action, priceVnd: t.priceVnd,
        qty: t.qty, reason: t.reason, decidedAt: t.decidedAt,
      })),
      lessons: lessons.map(l => ({
        id: l.id, lesson: l.lesson, confidence: l.confidence,
      })),
    },
    constraints: {
      maxNewPicks: picksPerSession,
      maxPositions: risk.maxPositions,
      maxPositionPctNav: risk.maxPositionPctNav,
      minLot: 100,
      availableCash: portfolio.cash,
      tradableSymbols: universe.map(u => u.symbol),
    },
  };
}
