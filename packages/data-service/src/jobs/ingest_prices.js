import { collectPrices } from '../collectors/prices.js';
import { computeIndicators, REQUIRED_INDICATOR_KEYS } from '../collectors/indicators_calc.js';
import { nowVnDate } from '../lib/vn_time.js';

const JOB = 'ingest_prices';

/**
 * Ingest giá + chỉ báo cho toàn bộ universe.
 * Lỗi một mã không chặn các mã còn lại (spec §5.3).
 */
export async function runIngestPrices({ broker, repos, logger = console, barCount = 60 }) {
  const startedAt = Date.now();
  const tradeDate = nowVnDate();

  const connected = await broker.ensureConnected();
  if (!connected) {
    await repos.ops.setSessionState(tradeDate, 'DATA_STALE', {
      note: 'không kết nối được CDP',
    });
    await repos.ops.logIngestError(JOB, null, 'không kết nối được CDP');
    await repos.events.appendEvent({
      type: 'data.stale',
      payload: { job: JOB, reason: 'cdp_unavailable' },
    });
    logger.error('[ingest_prices] bỏ qua: CDP không khả dụng');
    return { tradeDate, total: 0, succeeded: 0, failed: 0, failedSymbols: [], durationMs: Date.now() - startedAt };
  }

  const symbols = (await repos.universe.listActive()).map(s => s.symbol);
  const failedSymbols = [];
  let succeeded = 0;

  for (const symbol of symbols) {
    try {
      const bars = await collectPrices(broker, symbol, { count: barCount });
      await repos.market.upsertOhlcvBars(symbol, bars);

      // Chỉ báo TỰ TÍNH từ bars, không đọc từ TradingView.
      // `getStudyValues()` lấy giá trị từ Data Window, mà TradingView chỉ
      // điền khi con trỏ nằm trên chart — chạy tự động lúc 8h30 thì nó trả
      // rỗng. Đã kiểm chứng trên chart thật: chart có RSI nhưng
      // getStudyValues() chỉ trả ["Volume"].
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
