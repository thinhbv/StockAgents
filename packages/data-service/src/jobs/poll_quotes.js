import { collectQuotes } from '../collectors/quotes.js';
import { isTradingWindow } from '../lib/vn_time.js';

const JOB = 'poll_quotes';

/**
 * Cron của job này chạy mỗi 5 phút suốt 09:00–14:55 (spec §5.2) — đơn giản
 * và dễ đọc, nhưng rộng hơn giờ giao dịch thật (bao gồm cả nghỉ trưa
 * 11:30–13:00 và hai đầu ngày). `isTradingWindow` lọc chính xác ở đây thay
 * vì mã hoá vào biểu thức cron (Finding 1) — mỗi lần chạy ngoài giờ vẫn
 * chiếm mutex CDP, tốn retry vào chart cũ, và có thể ghi tick rác.
 */
export async function runPollQuotes({ broker, repos, symbols, logger = console, now = new Date() }) {
  if (!symbols || symbols.length === 0) return { inserted: 0, failed: 0 };

  // Lịch lễ đọc từ DB mỗi lần chạy, không cache: job này chạy 5 phút một lần
  // nên một truy vấn nhỏ là không đáng kể, đổi lại thêm một ngày lễ vào bảng
  // có hiệu lực ngay mà không phải khởi động lại tiến trình.
  const holidays = await repos.ops.listHolidays();

  if (!isTradingWindow(now, holidays)) {
    logger.info('[poll_quotes] ngoài giờ giao dịch, bỏ qua');
    return { inserted: 0, failed: 0, skipped: true };
  }

  const { ticks, errors } = await collectQuotes(broker, symbols);
  const inserted = await repos.market.insertQuoteTicks(ticks);

  for (const e of errors) {
    await repos.ops.logIngestError(JOB, e.symbol, e.message);
  }

  logger.info(`[poll_quotes] ${inserted} tick, ${errors.length} lỗi`);
  return { inserted, failed: errors.length };
}
