import { collectFundamentalsBatch } from '../collectors/fundamentals.js';

const JOB = 'ingest_fundamentals';

/**
 * Job ngày: chỉ số tài chính cơ bản cho toàn bộ universe.
 *
 * Chạy 1 lần/ngày là đủ — báo cáo tài chính chỉ đổi theo quý, không cần
 * lịch dày như ingest_prices. Không đụng session_state: đây là dữ liệu bổ
 * sung (best-effort) cho phân tích, không phải cổng an toàn giao dịch như
 * giá — một mã thiếu chỉ số cơ bản không nên chặn cả phiên mở cửa.
 */
export async function runIngestFundamentals({ repos, logger = console, fetchImpl = fetch }) {
  const universe = await repos.universe.listActive();
  if (universe.length === 0) return { succeeded: 0, failed: 0 };

  const { snapshots, errors } = await collectFundamentalsBatch(universe.map(u => u.symbol), fetchImpl);

  for (const s of snapshots) {
    await repos.fundamentals.insertSnapshot(s.symbol, s.payload);
  }
  for (const e of errors) {
    await repos.ops.logIngestError(JOB, e.symbol, e.message);
  }

  await repos.events.appendEvent({
    type: 'fundamentals.ingested',
    payload: {
      job: JOB, total: universe.length, succeeded: snapshots.length,
      failed: errors.length, failedSymbols: errors.map(e => e.symbol),
    },
  });

  logger.info(`[${JOB}] ${snapshots.length}/${universe.length} mã`);
  return { succeeded: snapshots.length, failed: errors.length };
}
