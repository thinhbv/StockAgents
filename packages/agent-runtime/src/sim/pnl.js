import { loadPortfolio } from './portfolio.js';

/**
 * Chốt phiên: mark-to-market toàn bộ vị thế và ghi snapshot.
 *
 * dayPnl so với snapshot GẦN NHẤT TRƯỚC ĐÓ, không phải vốn ban đầu — nếu
 * không, "lãi/lỗ trong ngày" sẽ thành "lãi/lỗ luỹ kế" và ngưỡng chặn lỗ ngày
 * (guardrails) sẽ hiểu sai hoàn toàn.
 */
export async function closeSession({ repos, agentId, tradeDate, priceMap }) {
  const agent = await repos.agents.get(agentId);
  if (!agent) throw new Error(`closeSession: không tìm thấy agent ${agentId}`);

  const p = await loadPortfolio({ repos, agentId, priceMap });
  const prev = await previousNav(repos, agentId, tradeDate);
  const dayPnl = p.nav - prev;

  await repos.agents.saveSnapshot(agentId, tradeDate, {
    cash: p.cash, marketValue: p.marketValue, nav: p.nav, dayPnl,
  });

  const totalReturnPct =
    Math.round(((p.nav - agent.initialCapital) / agent.initialCapital) * 10000) / 100;

  return { cash: p.cash, marketValue: p.marketValue, nav: p.nav, dayPnl, totalReturnPct };
}

/**
 * Mốc so sánh là snapshot của phiên TRƯỚC ĐÓ, không phải snapshot cùng ngày —
 * nếu lấy cùng ngày thì chạy lại lần hai sẽ luôn cho dayPnl = 0.
 */
async function previousNav(repos, agentId, tradeDate) {
  const snap = await repos.agents.getPreviousSnapshot(agentId, tradeDate);
  return snap ? snap.nav : (await repos.agents.get(agentId)).initialCapital;
}
