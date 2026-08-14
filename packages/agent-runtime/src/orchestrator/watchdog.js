import { evaluateTriggers, evaluateUniverseAlerts, isDebounced, DEBOUNCE_MINUTES } from './triggers.js';
import { loadPortfolio } from '../sim/portfolio.js';
import { EVENTS } from './events.js';

// STOP_LOSS và TRAILING đều là ngưỡng BẢO VỆ VỐN (cắt lỗ / khoá lãi đã có
// trước khi bốc hơi) — bán thẳng qua engine, không hỏi lại LLM: chậm một
// nhịp hỏi ý kiến ở đúng lúc giá đang rơi là mất thêm tiền thật (dù là tiền
// giả lập). TAKE_PROFIT/TIME_STOP/NEWS_ALERT/EOD_REVIEW vẫn đánh thức agent
// như cũ — đó là những lúc CÓ THỂ đáng cân nhắc tiếp (giữ thêm ăn theo xu
// hướng, tin chưa chắc đã xấu tới mức phải bán...), quyết định thuộc về agent.
const MECHANICAL_SELL_TRIGGERS = new Set(['STOP_LOSS', 'TRAILING']);

const TRIGGER_LABEL = { STOP_LOSS: 'cắt lỗ', TRAILING: 'chốt theo trailing' };

/**
 * Đặt lệnh SELL thị trường thẳng qua engine — không qua runner/LLM.
 *
 * Bán đúng số lượng ĐANG BÁN ĐƯỢC (qtySellable), không phải toàn bộ vị thế —
 * phần chưa qua T+2.5 thì có muốn cũng không bán được, engine sẽ tự từ chối
 * nếu lỡ truyền dư. Còn 0 cổ phiếu bán được thì báo REJECTED luôn, khỏi tốn
 * một lượt gọi engine.submit() chắc chắn bị checkSell chặn.
 */
async function autoSellPosition({ engine, agentId, position, trigger, tradeDate, tickPriceMap, refPriceMap, nav, dayPnl, risk, logger }) {
  const qty = position.qtySellable;
  if (!Number.isFinite(qty) || qty <= 0) {
    logger.warn(`[watchdog] ${agentId} ${position.symbol}: ${trigger.type} nổ nhưng chưa có cổ phiếu nào bán được (T+2.5)`);
    return { status: 'REJECTED', symbol: position.symbol, triggerType: trigger.type, reason: 'chưa qua T+2.5, chưa có cổ phiếu nào bán được' };
  }

  const decision = {
    action: 'SELL', symbol: position.symbol, quantity: qty, orderType: 'MARKET',
    reason: `Tự động ${TRIGGER_LABEL[trigger.type] ?? trigger.type}: ${trigger.reason}`,
    confidence: null, trigger: trigger.type,
  };
  const r = await engine.submit(agentId, decision, { tradeDate, refPriceMap, tickPriceMap, nav, dayPnl, risk });
  if (r.status === 'FILLED') {
    logger.info(`[watchdog] ${agentId} ${position.symbol}: ${trigger.type} tự động bán ${qty} cp @ ${r.fillPriceVnd}`);
  } else {
    logger.warn(`[watchdog] ${agentId} ${position.symbol}: ${trigger.type} tự bán thất bại — ${r.reason}`);
  }
  return { ...r, symbol: position.symbol, triggerType: trigger.type };
}

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

  async function tick({
    agentId, agentDef, now, tradeDate, tickPriceMap, refPriceMap, newsSentimentMap, universe = [],
  }) {
    // Khớp lệnh LIMIT đang treo với giá tick này TRƯỚC khi đánh giá trigger
    // — engine.matchPending() đã có sẵn và có test riêng, nhưng trước đây
    // không có nơi nào gọi nó trong vòng lặp thật, nên một lệnh LIMIT không
    // khớp ngay lúc mở cửa sẽ treo PENDING suốt phiên dù giá sau đó có chạm
    // ngưỡng. Vị thế mới khớp ở đây chỉ được evaluateTriggers nhìn thấy từ
    // tick SAU (positions bên dưới đã fetch trước khi hàm này chạy xong) —
    // chấp nhận được, nhất quán với việc mọi state trong vòng lặp đều là ảnh
    // chụp một lần mỗi tick, không riêng gì chỗ này.
    const pendingFilled = await engine.matchPending(agentId, { tradeDate, refPriceMap, tickPriceMap });

    const positions = await repos.trading.getOpenPositions(agentId);
    const result = {
      checked: 0, fired: [], debounced: [], woken: 0, results: [],
      autoSold: [], pendingFilled: pendingFilled.length,
    };

    const wakeFor = [];

    // NAV/dayPnl chỉ cần khi thật sự có trigger (bán máy móc HOẶC đánh thức
    // LLM) — nạp MỖI LẦN GỌI, không cache: một lệnh bán máy móc đổi cash/vị
    // thế ngay trong DB, nên lần gọi sau (cho vị thế khác, hoặc lúc đánh thức
    // LLM) phải thấy NAV mới, không phải ảnh chụp trước khi bán.
    async function getPortfolioAndDayPnl() {
      const portfolio = await loadPortfolio({ repos, agentId, priceMap: tickPriceMap });
      const prevSnap = await repos.agents.getPreviousSnapshot(agentId, tradeDate);
      const dayPnl = prevSnap ? portfolio.nav - prevSnap.nav : 0;
      return { portfolio, dayPnl };
    }

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

      // STOP_LOSS và TRAILING có thể nổ CÙNG lúc cho cùng một vị thế — bán
      // đúng 1 lần thôi, lệnh thứ hai sẽ chỉ khớp trên phần đã hết sạch.
      let autoSoldThisPosition = false;
      // TAKE_PROFIT/TRAILING cũng có thể nổ cùng lúc (giá tăng rồi tụt đủ sâu
      // khỏi đỉnh) — nếu TRAILING đã bán sạch vị thế, đừng đánh thức LLM hỏi
      // ý kiến về một vị thế không còn tồn tại nữa.
      let positionClosedThisTick = false;

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

        if (MECHANICAL_SELL_TRIGGERS.has(t.type)) {
          if (autoSoldThisPosition) continue;
          autoSoldThisPosition = true;
          const { portfolio, dayPnl } = await getPortfolioAndDayPnl();
          const sold = await autoSellPosition({
            engine, agentId, position: p, trigger: t, tradeDate,
            tickPriceMap, refPriceMap, nav: portfolio.nav, dayPnl,
            risk: agentDef.riskConfig, logger,
          });
          result.autoSold.push(sold);
          // Bán thành công thì thôi, không cần hỏi LLM nữa. Bán KHÔNG được
          // (ví dụ chưa qua T+2.5, chưa có cổ phiếu nào bán được) thì vẫn
          // đánh thức agent như đường cũ — còn nước còn tát.
          if (sold.status === 'FILLED') {
            positionClosedThisTick = true;
            // TAKE_PROFIT có thể đã đưa mã này vào wakeFor TRƯỚC khi tới
            // lượt TRAILING/STOP_LOSS bán sạch — dọn lại, khỏi hỏi LLM về
            // một vị thế vừa đóng.
            const idx = wakeFor.indexOf(t.symbol);
            if (idx !== -1) wakeFor.splice(idx, 1);
          } else {
            wakeFor.push(t.symbol);
          }
        } else if (!positionClosedThisTick && !wakeFor.includes(t.symbol)) {
          wakeFor.push(t.symbol);
        }
      }
    }

    // Nửa còn lại: mã KHÔNG giữ mà biến động mạnh hoặc dính tin xấu — trước
    // đây không ai biết cho tới phiên sau. Chỉ ghi sự kiện cho dashboard,
    // không đánh thức agent (xem lý do ở evaluateUniverseAlerts).
    const heldSymbols = new Set(positions.map(p => p.symbol));
    const watchSymbols = universe.map(u => u.symbol).filter(s => !heldSymbols.has(s));
    const universeAlerts = evaluateUniverseAlerts({
      symbols: watchSymbols, tickPriceMap, refPriceMap, newsSentimentMap,
    });

    for (const t of universeAlerts) {
      const lastFiredAt = await repos.triggers.getLastFired(agentId, t.symbol, t.type);
      if (isDebounced({ lastFiredAt, now, minutes: DEBOUNCE_MINUTES })) {
        result.debounced.push(t);
        continue;
      }
      await repos.triggers.recordFired(agentId, t.symbol, t.type, now);
      await repos.events.appendEvent({
        type: EVENTS.TRIGGER_FIRED, agentId, symbol: t.symbol,
        payload: { triggerType: t.type, reason: t.reason },
      });
      result.fired.push(t);
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
        const { portfolio, dayPnl } = await getPortfolioAndDayPnl();

        // Agent được hỏi "có bán không" nhưng nếu không biết đang giữ bao
        // nhiêu cổ phiếu thì không thể điền quantity — đã thấy trong log thật:
        // "quantity phải là số nguyên dương, nhận: undefined" vì context lúc
        // đánh thức trước đây thiếu hẳn phần này.
        const positionsBySymbol = new Map(positions.map(p => [p.symbol, p]));
        const wakePositions = wakeFor
          .map(symbol => positionsBySymbol.get(symbol))
          .filter(Boolean)
          .map(p => ({
            symbol: p.symbol, qtyTotal: p.qtyTotal, qtySellable: p.qtySellable,
            avgCostVnd: p.avgCostVnd,
          }));

        const run = await runner.runOnce({
          agentId, agentDef,
          context: { trigger: 'EXIT_THRESHOLD', firedTriggers: result.fired, positions: wakePositions },
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
