import { collectIntradayFlowBatch } from '../collectors/intraday_flow.js';
import { isTradingWindow } from '../lib/vn_time.js';

const JOB = 'poll_intraday_flow';

/**
 * Cùng nhịp 5 phút với poll_quotes (spec cron), vì VWAP/áp lực mua-bán chỉ
 * có nghĩa trong phiên — ngoài giờ thì bỏ qua, cùng lý do isTradingWindow ở
 * poll_quotes.js. Nguồn dữ liệu độc lập với CDP/TradingView (gọi VCI qua
 * HTTP), nên tách job riêng thay vì nhét vào poll_quotes — một job lỗi
 * (VCI sập) không kéo theo job kia (CDP vẫn ổn) ngừng ghi.
 */
export async function runPollIntradayFlow({ repos, symbols, logger = console, now = new Date(), fetchImpl = fetch }) {
  if (!symbols || symbols.length === 0) return { succeeded: 0, failed: 0 };

  const holidays = await repos.ops.listHolidays();
  if (!isTradingWindow(now, holidays)) {
    logger.info('[poll_intraday_flow] ngoài giờ giao dịch, bỏ qua');
    return { succeeded: 0, failed: 0, skipped: true };
  }

  const { snapshots, errors } = await collectIntradayFlowBatch(symbols, fetchImpl);

  for (const s of snapshots) {
    await repos.intradayFlow.insertSnapshot(s.symbol, s.payload);
  }
  for (const e of errors) {
    await repos.ops.logIngestError(JOB, e.symbol, e.message);
  }

  logger.info(`[poll_intraday_flow] ${snapshots.length}/${symbols.length} mã, ${errors.length} lỗi`);
  return { succeeded: snapshots.length, failed: errors.length };
}
