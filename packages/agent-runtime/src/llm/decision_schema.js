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
  if (d.confidence !== null && d.confidence !== undefined) {
    if (typeof d.confidence !== 'number' || !(d.confidence >= 0 && d.confidence <= 1)) {
      errors.push(`confidence phải trong khoảng 0..1, nhận: ${d.confidence}`);
    }
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
      exitPlan: d.exitPlan ?? {},
    },
  };
}
