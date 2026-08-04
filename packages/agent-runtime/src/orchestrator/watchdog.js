import { evaluateTriggers, isDebounced, DEBOUNCE_MINUTES } from './triggers.js';
import { loadPortfolio } from '../sim/portfolio.js';
import { EVENTS } from './events.js';

/**
 * Watchdog — vòng theo dõi 5 phút.
 *
 * BẤT BIẾN QUAN TRỌNG NHẤT: nếu không trigger nào nổ, KHÔNG lời gọi LLM nào
 * được phát ra. Cả cơ chế exitPlan tồn tại để chi phí token tỉ lệ với số
 * SỰ KIỆN chứ không phải số PHÚT (spec §6.3). Có test riêng canh điều này.
 */
export function createWatchdog({ repos, engine, runner, logger = console }) {

  function heldDaysOf(openedAt, now) {
    if (!openedAt) return 0;
    const ms = now.getTime() - new Date(openedAt).getTime();
    return Math.floor(ms / 86_400_000);
  }

  async function tick({ agentId, agentDef, now, tradeDate, tickPriceMap, refPriceMap, newsSentimentMap }) {
    const positions = await repos.trading.getOpenPositions(agentId);
    const result = { checked: 0, fired: [], debounced: [], woken: 0, results: [] };

    const wakeFor = [];

    for (const p of positions) {
      const lastPriceVnd = tickPriceMap.get(p.symbol);
      if (!Number.isFinite(lastPriceVnd)) {
        logger.warn(`[watchdog] ${agentId} ${p.symbol}: không có giá, bỏ qua nhịp này`);
        continue;
      }
      result.checked++;

      // Đỉnh giá chỉ đi lên. Trailing đo từ đỉnh nên nếu đỉnh tụt theo giá
      // thì trailing sẽ không bao giờ nổ.
      const peak = Math.max(lastPriceVnd, p.peakPriceVnd ?? 0);
      if (peak !== p.peakPriceVnd) {
        await repos.trading.upsertPosition(agentId, {
          symbol: p.symbol, qtyTotal: p.qtyTotal, qtySellable: p.qtySellable,
          avgCostVnd: p.avgCostVnd, exitPlan: p.exitPlan, peakPriceVnd: peak,
        });
      }

      const fired = evaluateTriggers({
        position: { ...p, peakPriceVnd: peak },
        lastPriceVnd,
        now,
        heldDays: heldDaysOf(p.openedAt, now),
        newsSentiment: newsSentimentMap?.get(p.symbol),
      });

      for (const t of fired) {
        const lastFiredAt = await repos.triggers.getLastFired(agentId, t.symbol, t.type);
        if (isDebounced({ lastFiredAt, now, minutes: DEBOUNCE_MINUTES })) {
          result.debounced.push(t);
          continue;
        }
        await repos.triggers.recordFired(agentId, t.symbol, t.type, now);
        await repos.events.appendEvent({
          type: EVENTS.TRIGGER_FIRED, agentId, symbol: t.symbol,
          payload: { triggerType: t.type, reason: t.reason, unrealizedPct: t.unrealizedPct },
        });
        result.fired.push(t);
        if (!wakeFor.includes(t.symbol)) wakeFor.push(t.symbol);
      }
    }

    // Một lời gọi LLM cho cả nhịp, mang theo mọi trigger vừa nổ — không phải
    // một lời gọi cho mỗi trigger.
    if (wakeFor.length > 0) {
      result.woken = 1;
      try {
        await repos.events.appendEvent({
          type: EVENTS.AGENT_STARTED, agentId,
          payload: { trigger: 'EXIT_THRESHOLD', symbols: wakeFor },
        });

        // NAV và lãi/lỗ ngày phải là số THẬT: guardrail chặn-lỗ-ngày đọc chúng.
        // Truyền 0 sẽ vô hiệu hoá cơ chế an toàn đó trên chính đường mà phần
        // lớn lệnh bán đi qua.
        const portfolio = await loadPortfolio({ repos, agentId, priceMap: tickPriceMap });
        const prevSnap = await repos.agents.getPreviousSnapshot(agentId, tradeDate);
        const dayPnl = prevSnap ? portfolio.nav - prevSnap.nav : 0;

        const run = await runner.runOnce({
          agentId, agentDef,
          context: { trigger: 'EXIT_THRESHOLD', firedTriggers: result.fired },
          ctx: {
            tradeDate, refPriceMap, tickPriceMap,
            nav: portfolio.nav, dayPnl, risk: agentDef.riskConfig,
          },
        });
        result.results = run.results ?? [];
      } catch (err) {
        // Watchdog phải sống sót qua lỗi provider — nó còn phải chạy tiếp
        // suốt phiên cho các vị thế khác.
        logger.error(`[watchdog] ${agentId} lỗi khi đánh thức agent: ${err.message}`);
        await repos.events.appendEvent({
          type: EVENTS.AGENT_SKIPPED, agentId, payload: { error: err.message },
        });
      }
    }

    return result;
  }

  return { tick };
}
