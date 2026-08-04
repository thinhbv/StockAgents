/**
 * Luật thị trường chứng khoán Việt Nam — TOÀN BỘ là hàm thuần.
 * Không DB, không LLM, không I/O. Đây là tầng duy nhất biết luật, và nó
 * test được bằng bảng case mà không cần dựng gì.
 */

// TradingView trả giá cổ phiếu VN ĐÃ TÍNH BẰNG VND — kiểm chứng trên dữ
// liệu thật ngày 2026-07-30: FPT 67.000, HPG 21.800, VCB 14.400, VNM 61.200.
//
// Bản đầu của Phase 2 giả định TradingView báo theo NGHÌN đồng và đặt hệ số
// 1000. Sai: nó biến mỗi cổ phiếu FPT thành 67 triệu đồng, tức sai 1000 lần
// trong mọi phép tính danh mục. assertPlausibleVndPrice bên dưới chính là
// hàng rào dựng cho tình huống này, và nó đã chặn đúng.
//
// Giữ lại hệ số cấu hình được để đổi nguồn dữ liệu sau này không phải sửa code.
export const PRICE_SCALE = Number(process.env.PRICE_SCALE ?? 1);

export const LOT_SIZE = 100;

export const BAND_PCT = Object.freeze({ HOSE: 7, HNX: 10, UPCOM: 15 });

// Khoảng giá hợp lý cho một cổ phiếu VN, tính bằng VND.
// Dùng để bắt lỗi SAI ĐƠN VỊ — thứ không tạo ra exception nào tự nhiên.
const MIN_PLAUSIBLE_VND = 1_000;
const MAX_PLAUSIBLE_VND = 10_000_000;

export function toVnd(price) {
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new Error(`toVnd: cần số hữu hạn, nhận được: ${price}`);
  }
  return Math.round(price * PRICE_SCALE);
}

/**
 * Chặn giá sai đơn vị. Quên nhân PRICE_SCALE cho ra ~118 VND; nhân hai lần
 * cho ra ~118 triệu. Cả hai đều là số hợp lệ về mặt kiểu dữ liệu và sẽ
 * chảy êm qua toàn hệ thống nếu không có hàng rào này.
 */
export function assertPlausibleVndPrice(vnd, context = '') {
  if (typeof vnd !== 'number' || !Number.isFinite(vnd)) {
    throw new Error(`assertPlausibleVndPrice: ${context} giá không hợp lệ: ${vnd}`);
  }
  if (vnd < MIN_PLAUSIBLE_VND || vnd > MAX_PLAUSIBLE_VND) {
    throw new Error(
      `assertPlausibleVndPrice: ${context} giá ${vnd} VND nằm ngoài khoảng hợp lý ` +
      `(${MIN_PLAUSIBLE_VND}–${MAX_PLAUSIBLE_VND}). Nhiều khả năng sai đơn vị: ` +
      `PRICE_SCALE hiện là ${PRICE_SCALE}.`,
    );
  }
  return vnd;
}

export function parseSymbol(symbol) {
  const parts = String(symbol).split(':');
  if (parts.length !== 2 || !BAND_PCT[parts[0]]) {
    throw new Error(
      `parseSymbol: '${symbol}' không hợp lệ. Cần dạng SAN:MA với sàn thuộc ` +
      `${Object.keys(BAND_PCT).join('/')}.`,
    );
  }
  return { exchange: parts[0], ticker: parts[1] };
}

export function tickSize(vnd) {
  if (vnd < 10_000) return 10;
  if (vnd < 50_000) return 50;
  return 100;
}

export function roundToTick(vnd) {
  const step = tickSize(vnd);
  return Math.round(vnd / step) * step;
}

/**
 * Biên độ dao động. Làm tròn VÀO TRONG: trần làm tròn xuống, sàn làm tròn lên.
 * Làm tròn ra ngoài sẽ sinh ra lệnh mà sàn thật từ chối.
 */
export function priceBand(refVnd, exchange) {
  const pct = BAND_PCT[exchange];
  if (!pct) throw new Error(`priceBand: sàn không hợp lệ: ${exchange}`);

  // Nhân TRƯỚC rồi mới chia, để tránh sai số dấu phẩy động.
  // `100000 * 1.15` cho 114999.99999999999, và làm tròn xuống bước giá
  // biến nó thành 114900 — lệch một bước giá ở đúng chỗ nhạy cảm nhất.
  // `100000 * 115 / 100` cho đúng 115000.
  const rawCeiling = (refVnd * (100 + pct)) / 100;
  const rawFloor = (refVnd * (100 - pct)) / 100;

  const ceiling = Math.floor(rawCeiling / tickSize(rawCeiling)) * tickSize(rawCeiling);
  const floor = Math.ceil(rawFloor / tickSize(rawFloor)) * tickSize(rawFloor);

  return { floor, ceiling };
}

export function normalizeQty(qty) {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new Error(`normalizeQty: cần số nguyên không âm, nhận được: ${qty}`);
  }
  return Math.floor(qty / LOT_SIZE) * LOT_SIZE;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * T+2.5 của VN: mua ngày T thì T+2 mới bán được.
 * Đếm theo PHIÊN (bỏ cuối tuần và ngày lễ), không phải ngày lịch.
 */
export function settlementDate(tradeDate, holidays = []) {
  if (!ISO_DATE.test(tradeDate)) {
    throw new Error(`settlementDate: cần định dạng YYYY-MM-DD, nhận được: ${tradeDate}`);
  }
  const skip = new Set(holidays);
  const d = new Date(`${tradeDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`settlementDate: ngày không hợp lệ: ${tradeDate}`);
  }

  let sessions = 0;
  while (sessions < 2) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6 || skip.has(iso)) continue;
    sessions++;
  }
  return d.toISOString().slice(0, 10);
}
