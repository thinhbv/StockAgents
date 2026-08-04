import { toVnDate } from '../lib/vn_time.js';

/**
 * Lấy bars hằng ngày cho một mã và chuẩn hóa về hình dạng repository cần.
 * `summary` cố ý KHÔNG dùng — ta cần từng bar để lưu lịch sử.
 */
export async function collectPrices(broker, symbol, { count = 60 } = {}) {
  const result = await broker.withSymbol(symbol, (core) => core.data.getOhlcv({ count }));

  const bars = result?.bars ?? [];
  if (bars.length === 0) {
    throw new Error(`collectPrices: ${symbol} không có bar nào trả về`);
  }

  return bars.map(b => {
    const tradeDate = toVnDate(b.time);
    const bar = {
      tradeDate,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      // TradingView trả volume dạng THẬP PHÂN cho một số mã (đã điều chỉnh /
    // trung bình hoá), ví dụ 3989132.0032604. Cột ohlcv_daily.volume là
    // BIGINT nên Postgres từ chối và cả mã đó bị bỏ qua.
    volume: Math.round(Number(b.volume ?? 0)),
    };
    // Number(undefined) là NaN, và node-pg/PostgreSQL NUMERIC CHẤP NHẬN 'NaN'
    // (nó còn qua được CHECK (v > 0) vì Postgres xếp NaN lớn hơn mọi số) — một
    // schema constraint không bắt được lỗi này. Phải chặn ở đây.
    for (const field of ['open', 'high', 'low', 'close', 'volume']) {
      if (!Number.isFinite(bar[field])) {
        throw new Error(
          `collectPrices: ${symbol} ngày ${tradeDate} có trường '${field}' không hợp lệ: ${b[field]}`);
      }
    }
    return bar;
  });
}
