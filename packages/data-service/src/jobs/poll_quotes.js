import { collectVciQuotes } from '../collectors/vci_prices.js';
import { isTradingWindow } from '../lib/vn_time.js';
import { priceBand, exchangeOf } from '../lib/price_band.js';

const JOB = 'poll_quotes';

/**
 * Cron của job này chạy mỗi 5 phút suốt 09:00–14:55 (spec §5.2) — đơn giản
 * và dễ đọc, nhưng rộng hơn giờ giao dịch thật (bao gồm cả nghỉ trưa
 * 11:30–13:00 và hai đầu ngày). `isTradingWindow` lọc chính xác ở đây thay
 * vì mã hoá vào biểu thức cron (Finding 1).
 *
 * Nguồn giá là API HTTP công khai Vietcap (VCI), KHÔNG qua CDP/TradingView
 * Desktop nữa — xem collectors/vci_prices.js.
 */
export async function runPollQuotes({ repos, symbols, logger = console, now = new Date(), fetchImpl }) {
  if (!symbols || symbols.length === 0) return { inserted: 0, failed: 0 };

  // Lịch lễ đọc từ DB mỗi lần chạy, không cache: job này chạy 5 phút một lần
  // nên một truy vấn nhỏ là không đáng kể, đổi lại thêm một ngày lễ vào bảng
  // có hiệu lực ngay mà không phải khởi động lại tiến trình.
  const holidays = await repos.ops.listHolidays();

  if (!isTradingWindow(now, holidays)) {
    logger.info('[poll_quotes] ngoài giờ giao dịch, bỏ qua');
    return { inserted: 0, failed: 0, skipped: true };
  }

  const { ticks, errors } = await collectVciQuotes(symbols, fetchImpl);

  // Không sàn thật nào cho khớp lệnh ngoài trần/sàn — một tick nằm ngoài
  // biên độ chắc chắn là dữ liệu rác, không phải biến động thật dù có tin
  // sốc đến đâu. Đã thấy hậu quả thật: một tick rác kiểu này (nguồn CDP cũ)
  // từng bị agent COI LÀ GIÁ THẬT và bán mất một vị thế với lãi ảo (ACB
  // 22.500 → "25.350" ngày 2026-08-25). VCI trả sẵn ceiling/floor CHÍNH
  // THỨC của đúng phiên đang chạy theo từng tick — dùng thẳng, không cần tự
  // tính lại từ giá đóng cửa hôm trước; chỉ khi thiếu (null) mới rơi về tính
  // từ ohlcv_daily làm lưới an toàn dự phòng.
  const needsFallbackRef = ticks.some(t => t.ceiling === null || t.floor === null);
  const refMap = needsFallbackRef ? await repos.market.getRefPrices(symbols) : null;
  const clean = [];
  for (const t of ticks) {
    let { ceiling, floor } = t;
    if (ceiling === null || floor === null) {
      const ref = refMap?.get(t.symbol);
      const band = ref ? priceBand(ref, exchangeOf(t.symbol)) : null;
      ceiling = band?.ceiling ?? null;
      floor = band?.floor ?? null;
    }
    if (ceiling !== null && floor !== null && (t.price < floor || t.price > ceiling)) {
      errors.push({
        symbol: t.symbol,
        message: `collectVciQuotes: giá ${t.price} ngoài biên độ [${floor}, ${ceiling}] — nghi dữ liệu rác, bỏ qua`,
      });
      continue;
    }
    clean.push(t);
  }

  const inserted = await repos.market.insertQuoteTicks(clean);

  for (const e of errors) {
    await repos.ops.logIngestError(JOB, e.symbol, e.message);
  }

  logger.info(`[poll_quotes] ${inserted} tick, ${errors.length} lỗi`);
  return { inserted, failed: errors.length };
}
