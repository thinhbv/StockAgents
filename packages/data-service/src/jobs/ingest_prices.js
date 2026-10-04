import { collectVciDailyBars } from '../collectors/vci_prices.js';
import { computeIndicators, REQUIRED_INDICATOR_KEYS } from '../collectors/indicators_calc.js';
import { nowVnDate } from '../lib/vn_time.js';

const JOB = 'ingest_prices';

/**
 * Ingest giá + chỉ báo cho toàn bộ universe — qua API HTTP công khai Vietcap
 * (VCI), KHÔNG qua CDP/TradingView Desktop nữa (xem collectors/vci_prices.js
 * để biết lý do bỏ CDP). Không còn bước "kết nối" riêng cần chờ trước vòng
 * lặp — mỗi mã tự gọi HTTP độc lập, một mã lỗi rơi thẳng vào nhánh catch bên
 * dưới như mọi lỗi khác, không cần nhánh DATA_STALE riêng cho "mất kết nối".
 * Lỗi một mã không chặn các mã còn lại (spec §5.3).
 */
export async function runIngestPrices({
  repos, logger = console, barCount = 60, fetchImpl, maxRetries, baseDelayMs, sleep,
}) {
  const startedAt = Date.now();
  const tradeDate = nowVnDate();

  const symbols = (await repos.universe.listActive()).map(s => s.symbol);
  const failedSymbols = [];
  let succeeded = 0;

  for (const symbol of symbols) {
    try {
      const bars = await collectVciDailyBars(symbol, {
        count: barCount, fetchImpl, maxRetries, baseDelayMs, sleep,
      });
      await repos.market.upsertOhlcvBars(symbol, bars);

      // Chỉ báo TỰ TÍNH từ bars, không đọc sẵn từ nguồn ngoài — VCI không
      // trả chỉ báo kỹ thuật, chỉ trả OHLCV thô.
      const parsed = computeIndicators(bars);
      const missing = REQUIRED_INDICATOR_KEYS.filter(k => !Number.isFinite(parsed[k]));
      if (missing.length > 0) {
        throw new Error(
          `${symbol}: thiếu khóa chỉ báo bắt buộc sau khi tính: ${missing.join(', ')} ` +
          `(chỉ có ${bars.length} bar, cần ít nhất 35)`);
      }
      await repos.market.insertIndicatorSnapshot(symbol, parsed);

      succeeded++;
      logger.info(`[ingest_prices] ${symbol}: ${bars.length} bar`);
    } catch (err) {
      failedSymbols.push(symbol);
      await repos.ops.logIngestError(JOB, symbol, err.message);
      logger.warn(`[ingest_prices] ${symbol} lỗi: ${err.message}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  const total = symbols.length;

  // Ngưỡng trạng thái (Finding 1): orchestrator dựa vào session_state để
  // quyết định có mở phiên giao dịch hay không — một mã thành công trong ba
  // mươi mã không được coi là "sẵn sàng". Chỉ toàn bộ mã thành công VÀ chỉ
  // báo thiết lập được mới là DATA_READY; một phần thành công (hoặc chỉ báo
  // hỏng dù giá vẫn lấy được) là DATA_PARTIAL; không mã nào thành công là
  // DATA_STALE.
  let state;
  if (succeeded === 0) {
    state = 'DATA_STALE';
  } else if (succeeded === total) {
    state = 'DATA_READY';
  } else {
    state = 'DATA_PARTIAL';
  }

  const note = `${succeeded}/${total} mã thành công`;

  await repos.ops.setSessionState(tradeDate, state, {
    // Chỉ cập nhật mốc thời gian "dữ liệu mới" khi phiên hoàn tất TOÀN BỘ —
    // một lần chạy dở dang không được làm mới dấu thời gian, để consumer sau
    // này vẫn biết lần bắt trọn vẹn gần nhất là khi nào.
    dataCapturedAt: state === 'DATA_READY' ? new Date() : null,
    note,
  });

  await repos.events.appendEvent({
    type: state === 'DATA_READY' ? 'data.ingested' : 'data.stale',
    payload: {
      job: JOB, tradeDate, total,
      succeeded, failed: failedSymbols.length, failedSymbols, durationMs,
    },
  });

  logger.info(
    `[ingest_prices] xong: ${succeeded}/${symbols.length} mã trong ${(durationMs / 1000).toFixed(1)}s`);

  return {
    tradeDate, total: symbols.length, succeeded,
    failed: failedSymbols.length, failedSymbols, durationMs,
  };
}
