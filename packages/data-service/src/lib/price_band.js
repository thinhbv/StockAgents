/**
 * Biên độ dao động trần/sàn HOSE/HNX/UPCOM — bản rút gọn, chỉ đủ để lọc tick
 * rác trước khi ghi quote_tick. Không import từ agent-runtime (ranh giới
 * kiến trúc: data-service điều phối LỊCH, không phụ thuộc gói mô phỏng
 * agent — xem comment ở đầu index.js) nên logic tính band được chép lại
 * đây, KHÔNG dùng chung với packages/agent-runtime/src/sim/vn_rules.js.
 * Đổi %biên độ ở đó thì phải tự sửa lại ở đây.
 */

const BAND_PCT = Object.freeze({ HOSE: 7, HNX: 10, UPCOM: 15 });

function tickSize(vnd) {
  if (vnd < 10_000) return 10;
  if (vnd < 50_000) return 50;
  return 100;
}

export function priceBand(refVnd, exchange) {
  const pct = BAND_PCT[exchange];
  if (!pct) return null;
  const rawCeiling = (refVnd * (100 + pct)) / 100;
  const rawFloor = (refVnd * (100 - pct)) / 100;
  return {
    floor: Math.ceil(rawFloor / tickSize(rawFloor)) * tickSize(rawFloor),
    ceiling: Math.floor(rawCeiling / tickSize(rawCeiling)) * tickSize(rawCeiling),
  };
}

export function exchangeOf(symbol) {
  return String(symbol).split(':')[0];
}
