/**
 * Hàng rào cứng, nằm NGOÀI tầm với của LLM (spec §7.2, §3.3).
 * Agent chỉ đề xuất; những hàm này là trọng tài.
 *
 * KHÔNG BAO GIỜ ném lỗi — luôn trả { ok, reason } để engine ghi lý do vào
 * orders.reject_reason. Lệnh bị từ chối là dữ liệu học, không phải sự cố.
 */

export const DEFAULT_RISK = Object.freeze({
  maxPositionPctNav: 20,
  dailyLossLimitPct: 5,
});

const deny = (reason) => ({ ok: false, reason });
const allow = () => ({ ok: true });

export function checkBuy({
  symbol, costVnd, cash, nav, positions, risk = DEFAULT_RISK, indicatorsMissing = false,
}) {
  // Thiếu chỉ báo kỹ thuật cho mã này (đã có giá nhưng không có RSI/MACD/MA...)
  // thì không mở vị thế MỚI — cùng triết lý với DATA_STALE chặn cả phiên
  // (spec §4), chỉ thu hẹp xuống một mã thay vì cả universe. Bán vẫn cho phép
  // (checkSell không đụng tới) vì thoát vị thế để bảo toàn vốn không nên bị chặn.
  if (indicatorsMissing) return deny(`thiếu chỉ báo kỹ thuật cho ${symbol} — không mở vị thế mới khi thiếu dữ liệu`);
  if (!Number.isFinite(costVnd) || costVnd <= 0) return deny(`chi phí không hợp lệ: ${costVnd}`);
  if (!Number.isFinite(cash)) return deny(`tiền mặt không hợp lệ: ${cash}`);
  if (!Number.isFinite(nav) || nav <= 0) return deny(`NAV không hợp lệ: ${nav}`);

  if (costVnd > cash) {
    return deny(`không đủ tiền mặt: cần ${costVnd}, có ${cash}`);
  }

  const pctNav = (costVnd / nav) * 100;
  if (pctNav > risk.maxPositionPctNav) {
    return deny(
      `vượt tỷ trọng tối đa một mã: ${pctNav.toFixed(1)}% > ${risk.maxPositionPctNav}% NAV`);
  }

  // Không giới hạn SỐ LOẠI mã đang giữ — agent tự quyết định dàn trải bao
  // nhiêu mã. Tiền mặt và tỷ trọng tối đa/mã ở trên vẫn chặn được cả hai rủi
  // ro thật (đòn bẩy, dồn hết vào một mã); còn số lượng mã là lựa chọn của
  // agent, không phải hàng rào rủi ro.
  return allow();
}

export function checkSell({ symbol, qty, positions }) {
  const p = positions.find(x => x.symbol === symbol);
  if (!p) return deny(`không có vị thế ${symbol} để bán`);
  if (!Number.isInteger(qty) || qty <= 0) return deny(`khối lượng bán không hợp lệ: ${qty}`);

  if (qty > p.qtySellable) {
    return deny(
      `bán ${qty} vượt số lượng bán được ${p.qtySellable} ` +
      `(đang giữ ${p.qtyTotal}, phần còn lại chưa về tài khoản theo T+2)`);
  }
  return allow();
}

export function checkDailyLoss({ dayPnl, nav, risk = DEFAULT_RISK }) {
  if (!Number.isFinite(dayPnl) || !Number.isFinite(nav) || nav <= 0) return allow();
  const lossPct = (-dayPnl / nav) * 100;
  if (lossPct > risk.dailyLossLimitPct) {
    return deny(
      `lỗ trong ngày ${lossPct.toFixed(1)}% vượt ngưỡng ${risk.dailyLossLimitPct}% — ` +
      `dừng giao dịch phần còn lại của phiên`);
  }
  return allow();
}
