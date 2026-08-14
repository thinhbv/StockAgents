/**
 * Hợp đồng quyết định của agent (spec §6.2).
 * Đầu ra LLM PHẢI qua đây trước khi chạm engine — LLM không được giữ
 * quy tắc an toàn, và cũng không được tin là trả đúng định dạng.
 *
 * Gom TẤT CẢ lỗi thay vì dừng ở lỗi đầu: khi cần sửa prompt, thấy hết
 * vấn đề một lần thì nhanh hơn nhiều so với sửa từng cái một.
 */

export const DECISION_KEYS = [
  'action', 'symbol', 'quantity', 'orderType', 'limitPriceVnd',
  'confidence', 'reason', 'exitPlan',
];

const ACTIONS = new Set(['BUY', 'SELL', 'HOLD']);
const ORDER_TYPES = new Set(['MARKET', 'LIMIT', 'ATC']);

// LLM đôi khi trả stopLossPct/takeProfitPct/trailingPct dương-âm lẫn lộn —
// "cắt lỗ 5%" và "cắt lỗ -5%" cùng một ý nhưng khác dấu. triggers.js so sánh
// unrealizedPct <= stopLossPct: nếu dấu sai, ngưỡng cắt lỗ dương sẽ khớp
// gần như ngay khi mua (vì lãi thường chưa vượt qua số dương đó), bán oan.
// Ép dấu ở đây — điểm nạp DUY NHẤT của mọi exitPlan — để không agent nào
// né được, thay vì sửa từng nơi gọi.
function normalizeExitPlan(plan) {
  if (!plan || typeof plan !== 'object') return {};
  const p = { ...plan };
  if (Number.isFinite(p.stopLossPct)) p.stopLossPct = -Math.abs(p.stopLossPct);
  if (Number.isFinite(p.takeProfitPct)) p.takeProfitPct = Math.abs(p.takeProfitPct);
  if (Number.isFinite(p.trailingPct)) p.trailingPct = Math.abs(p.trailingPct);
  return p;
}

export function validateDecision(raw) {
  const errors = [];
  const d = raw ?? {};

  if (!ACTIONS.has(d.action)) {
    errors.push(`action phải thuộc ${[...ACTIONS].join('/')}, nhận: ${d.action}`);
  }
  if (typeof d.symbol !== 'string' || d.symbol.trim() === '') {
    errors.push('symbol phải là chuỗi không rỗng');
  }
  if (typeof d.reason !== 'string' || d.reason.trim() === '') {
    errors.push('reason bắt buộc và không được rỗng — lý do là dữ liệu cho vòng học');
  }
  // Bắt buộc, không chỉ kiểm khi có mặt — đây là thang điểm CHUNG cho cả 5
  // agent (spec §10 metrics), nên một agent bỏ trống sẽ làm hỏng phép so
  // sánh confidenceCalibration giữa các agent (sim/metrics.js).
  if (typeof d.confidence !== 'number' || !(d.confidence >= 0 && d.confidence <= 1)) {
    errors.push(`confidence bắt buộc và phải trong khoảng 0..1, nhận: ${d.confidence}`);
  }

  if (d.action === 'BUY' || d.action === 'SELL') {
    if (!Number.isInteger(d.quantity) || d.quantity <= 0) {
      errors.push(`quantity phải là số nguyên dương, nhận: ${d.quantity}`);
    }
    const type = d.orderType ?? 'MARKET';
    if (!ORDER_TYPES.has(type)) {
      errors.push(`orderType phải thuộc ${[...ORDER_TYPES].join('/')}, nhận: ${type}`);
    }
    if (type === 'LIMIT' && !Number.isFinite(d.limitPriceVnd)) {
      errors.push('orderType LIMIT bắt buộc có limitPriceVnd là số');
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      action: d.action,
      symbol: d.symbol.trim(),
      quantity: d.quantity ?? null,
      orderType: d.orderType ?? 'MARKET',
      limitPriceVnd: Number.isFinite(d.limitPriceVnd) ? d.limitPriceVnd : null,
      confidence: typeof d.confidence === 'number' ? d.confidence : null,
      reason: d.reason.trim(),
      exitPlan: normalizeExitPlan(d.exitPlan),
    },
  };
}
