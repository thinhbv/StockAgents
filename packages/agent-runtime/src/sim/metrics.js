/**
 * Sáu chỉ số của spec §10, tính từ `trade_outcomes` và `portfolio_snapshot`.
 *
 * Phần tính toán là HÀM THUẦN để test được bằng bảng số liệu; chỉ hàm
 * `computeAndSaveMetrics` ở cuối mới chạm database.
 */

const TRADING_DAYS_PER_YEAR = 252;

/** Tỷ lệ lệnh có lãi trên tổng số vòng đã đóng. */
export function winRate(outcomes) {
  if (outcomes.length === 0) return null;
  const wins = outcomes.filter(o => o.pnl > 0).length;
  return Math.round((wins / outcomes.length) * 10000) / 10000;
}

/**
 * Sharpe niên hoá từ chuỗi lợi suất NGÀY.
 *
 * Dùng độ lệch chuẩn MẪU (chia n−1): chuỗi NAV của ta là một mẫu quan sát,
 * không phải toàn bộ tổng thể. Chia n sẽ thổi phồng Sharpe một cách hệ thống
 * khi số phiên còn ít — đúng lúc người ta dễ tin nhất.
 */
export function sharpe(dailyReturns) {
  if (dailyReturns.length < 2) return null;

  const n = dailyReturns.length;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / n;
  const variance = dailyReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);

  if (sd === 0) return null;   // không biến động thì Sharpe vô nghĩa, không phải vô cực
  return Math.round((mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 10000) / 10000;
}

/** Sụt giảm sâu nhất từ đỉnh NAV, trả về số DƯƠNG theo phần trăm. */
export function maxDrawdown(navSeries) {
  if (navSeries.length === 0) return null;

  let peak = navSeries[0];
  let worst = 0;
  for (const nav of navSeries) {
    if (nav > peak) peak = nav;
    if (peak > 0) {
      const dd = (peak - nav) / peak;
      if (dd > worst) worst = dd;
    }
  }
  return Math.round(worst * 10000) / 100;
}

export function avgHoldingDays(outcomes) {
  if (outcomes.length === 0) return null;
  const total = outcomes.reduce((a, o) => a + o.holdingDays, 0);
  return Math.round((total / outcomes.length) * 100) / 100;
}

/** Tỷ lệ bài học thực sự giúp được, trên toàn bộ lần được truy xuất. */
export function lessonHitRate(lessons) {
  const retrieved = lessons.reduce((a, l) => a + (l.timesRetrieved ?? 0), 0);
  if (retrieved === 0) return null;
  const helped = lessons.reduce((a, l) => a + (l.timesHelped ?? 0), 0);
  return Math.round((helped / retrieved) * 10000) / 10000;
}

/** Chuỗi lợi suất ngày từ chuỗi NAV theo thứ tự thời gian. */
export function dailyReturns(navSeries) {
  const out = [];
  for (let i = 1; i < navSeries.length; i++) {
    const prev = navSeries[i - 1];
    if (prev > 0) out.push((navSeries[i] - prev) / prev);
  }
  return out;
}

/**
 * Tính và lưu metric cho một agent tại một ngày.
 * Idempotent — chạy lại cùng ngày thì ghi đè, không nhân đôi.
 */
export async function computeAndSaveMetrics({ repos, agentId, tradeDate }) {
  const agent = await repos.agents.get(agentId);
  if (!agent) throw new Error(`computeAndSaveMetrics: không tìm thấy agent ${agentId}`);

  const outcomes = await repos.trading.listOutcomes(agentId, 1000);
  const navSeries = await repos.agents.listNavSeries(agentId);
  const lessons = repos.lessons ? await repos.lessons.listActive(agentId, 500) : [];

  const latestNav = navSeries.length > 0 ? navSeries[navSeries.length - 1] : agent.initialCapital;

  const metrics = {
    totalReturnPct: Math.round(
      ((latestNav - agent.initialCapital) / agent.initialCapital) * 10000) / 100,
    winRate: winRate(outcomes),
    sharpe: sharpe(dailyReturns(navSeries)),
    maxDrawdown: maxDrawdown(navSeries),
    avgHoldingDays: avgHoldingDays(outcomes),
    tradeCount: outcomes.length,
    lessonHitRate: lessonHitRate(lessons),
  };

  await repos.agents.saveMetrics(agentId, tradeDate, metrics);
  return metrics;
}
