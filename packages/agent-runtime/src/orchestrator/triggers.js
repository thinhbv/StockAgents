/**
 * Đánh giá điều kiện thoát — HÀM THUẦN.
 *
 * Đây là thứ chạy 60 lần mỗi ngày cho mỗi vị thế. Nó phải rẻ, tất định, và
 * KHÔNG BAO GIỜ gọi LLM. Cả cơ chế exitPlan tồn tại để chi phí token tỉ lệ
 * với số SỰ KIỆN chứ không phải số PHÚT (spec §6.3).
 *
 * Thời gian truyền vào qua `now` chứ không đọc đồng hồ hệ thống — nếu không
 * test sẽ phụ thuộc giờ chạy và chẳng chứng minh được gì.
 */

export const TRIGGER_TYPES = Object.freeze([
  'TAKE_PROFIT', 'STOP_LOSS', 'TRAILING', 'TIME_STOP', 'NEWS_ALERT', 'EOD_REVIEW',
]);

export const DEBOUNCE_MINUTES = 30;

// Ngưỡng tin xấu đủ mạnh để đánh thức agent. Tin hơi tiêu cực thì không —
// nếu không mỗi bản tin thường ngày đều tốn một lời gọi LLM.
const NEWS_ALERT_THRESHOLD = -0.5;

// 14:30 giờ VN — rà soát một lần trước khi đóng cửa.
const EOD_HOUR = 14;
const EOD_MINUTE = 30;

const vnParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false,
});

function vnHourMinute(now) {
  const parts = vnParts.formatToParts(now);
  const hour = Number(parts.find(p => p.type === 'hour').value);
  const minute = Number(parts.find(p => p.type === 'minute').value);
  return { hour, minute };
}

export function evaluateTriggers({ position, lastPriceVnd, now, heldDays, newsSentiment }) {
  const fired = [];
  const plan = position.exitPlan ?? {};
  const { symbol, avgCostVnd, peakPriceVnd } = position;

  if (!Number.isFinite(lastPriceVnd) || !Number.isFinite(avgCostVnd) || avgCostVnd <= 0) {
    return fired;
  }

  const unrealizedPct = Math.round(((lastPriceVnd - avgCostVnd) / avgCostVnd) * 10000) / 100;
  const add = (type, reason) => fired.push({ type, symbol, reason, unrealizedPct });

  if (Number.isFinite(plan.takeProfitPct) && unrealizedPct >= plan.takeProfitPct) {
    add('TAKE_PROFIT', `lãi ${unrealizedPct}% chạm mục tiêu ${plan.takeProfitPct}%`);
  }

  if (Number.isFinite(plan.stopLossPct) && unrealizedPct <= plan.stopLossPct) {
    add('STOP_LOSS', `lỗ ${unrealizedPct}% chạm ngưỡng cắt ${plan.stopLossPct}%`);
  }

  // Trailing tính từ ĐỈNH kể từ lúc mua, không phải từ giá vốn. Một vị thế
  // đang lãi 16% vẫn phải nổ nếu đã tụt đủ sâu khỏi đỉnh 20%.
  if (Number.isFinite(plan.trailingPct) && Number.isFinite(peakPriceVnd) && peakPriceVnd > 0) {
    const dropPct = Math.round(((peakPriceVnd - lastPriceVnd) / peakPriceVnd) * 10000) / 100;
    if (dropPct >= plan.trailingPct) {
      add('TRAILING', `tụt ${dropPct}% từ đỉnh ${peakPriceVnd} (ngưỡng ${plan.trailingPct}%)`);
    }
  }

  if (Number.isFinite(plan.timeStopDays) && Number.isFinite(heldDays)
      && heldDays >= plan.timeStopDays) {
    add('TIME_STOP', `đã giữ ${heldDays} phiên, chạm hạn ${plan.timeStopDays} phiên`);
  }

  if (Number.isFinite(newsSentiment) && newsSentiment <= NEWS_ALERT_THRESHOLD) {
    add('NEWS_ALERT', `tin tiêu cực mạnh (sentiment ${newsSentiment})`);
  }

  // EOD_REVIEW chỉ áp dụng cho vị thế CÓ kế hoạch thoát. Vị thế không khai
  // exitPlan là agent cố ý không đặt điều kiện — đừng đánh thức nó vô cớ.
  if (Object.keys(plan).length > 0) {
    const { hour, minute } = vnHourMinute(now);
    if (hour > EOD_HOUR || (hour === EOD_HOUR && minute >= EOD_MINUTE)) {
      add('EOD_REVIEW', 'rà soát trước khi đóng cửa phiên');
    }
  }

  return fired;
}

export function isDebounced({ lastFiredAt, now, minutes = DEBOUNCE_MINUTES }) {
  if (!lastFiredAt) return false;
  const elapsedMs = now.getTime() - new Date(lastFiredAt).getTime();
  return elapsedMs < minutes * 60_000;
}

// Ngưỡng biến động đủ mạnh để đáng chú ý trên một mã CHƯA giữ — không phải
// ngưỡng vào lệnh, chỉ là "đáng nhìn". Biên độ HOSE ±7% nên 5% đã là dịch
// chuyển thật, không phải nhiễu quanh tham chiếu.
export const UNIVERSE_MOVE_THRESHOLD_PCT = 5;

/**
 * Rà universe cho các mã KHÔNG nằm trong vị thế đang giữ — vị thế đang giữ đã
 * có evaluateTriggers() lo. Đây là nửa còn lại của watchdog: mã chưa mua biến
 * động mạnh hoặc dính tin xấu thì trước đây không ai biết cho tới phiên sau.
 *
 * HÀM THUẦN như evaluateTriggers — không gọi LLM. Watchdog chỉ GHI LẠI các
 * alert này để hiện lên dashboard; không tự đánh thức agent để cân nhắc mua,
 * vì watchdog không có đủ ngữ cảnh (chỉ báo, khối lượng) để agent không mua mù.
 */
export function evaluateUniverseAlerts({
  symbols, tickPriceMap, refPriceMap, newsSentimentMap,
  moveThresholdPct = UNIVERSE_MOVE_THRESHOLD_PCT,
}) {
  const fired = [];
  for (const symbol of symbols) {
    const lastPriceVnd = tickPriceMap.get(symbol);
    const refPriceVnd = refPriceMap.get(symbol);
    if (Number.isFinite(lastPriceVnd) && Number.isFinite(refPriceVnd) && refPriceVnd > 0) {
      const changePct = Math.round(((lastPriceVnd - refPriceVnd) / refPriceVnd) * 10000) / 100;
      if (Math.abs(changePct) >= moveThresholdPct) {
        fired.push({
          type: 'PRICE_MOVE', symbol, changePct,
          reason: `giá ${changePct > 0 ? 'tăng' : 'giảm'} ${Math.abs(changePct)}% so với tham chiếu`,
        });
      }
    }

    const sentiment = newsSentimentMap?.get(symbol);
    if (Number.isFinite(sentiment) && sentiment <= NEWS_ALERT_THRESHOLD) {
      fired.push({ type: 'NEWS_ALERT', symbol, sentiment, reason: `tin tiêu cực mạnh (sentiment ${sentiment})` });
    }
  }
  return fired;
}
