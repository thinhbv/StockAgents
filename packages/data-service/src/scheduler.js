import cron from 'node-cron';

const TZ = 'Asia/Ho_Chi_Minh';

export const SCHEDULES = [
  { name: 'ingest_prices', cron: '30 8 * * 1-5' },
  { name: 'ingest_news', cron: '45 8 * * 1-5' },
  // 09:15 mở cửa — chạy cả 5 agent trên cùng dữ liệu.
  { name: 'run_session', cron: '15 9 * * 1-5' },
  // 15:00 — sau khi sàn đóng và mọi phiên đã chốt.
  { name: 'report_day', cron: '0 15 * * 1-5' },
  { name: 'poll_quotes', cron: '*/5 9-14 * * 1-5' },
  { name: 'prune_events', cron: '0 2 * * *' },
];

/**
 * `cronLib` được truyền vào để test không phải chờ đồng hồ thật.
 * Job ném lỗi được nuốt và ghi log — một job hỏng không được làm sập tiến trình.
 */
export function startScheduler({ jobs, cronLib = cron, logger = console }) {
  // Xác thực TRƯỚC KHI đăng ký bất kỳ job nào (Finding 3) — nếu việc kiểm
  // tra nằm trong .map() và ném lỗi ở job thứ ba, hai job đầu đã được đăng
  // ký với timer thật rồi, không còn handle nào để stop() chúng.
  for (const { name } of SCHEDULES) {
    if (!jobs[name]) throw new Error(`startScheduler: thiếu hàm cho job "${name}"`);
  }

  // Job đang chạy dở (nếu có) — theo dõi bằng một biến duy nhất là đủ vì
  // các job không bao giờ chồng lấn nhau, chúng đã được serialize bởi mutex
  // của CDP broker rồi (Finding 2). `drain()` dùng biến này để chờ job đang
  // chạy xong TRƯỚC KHI tiến trình đóng connection pool khi shutdown —
  // thiếu bước này, một restart PM2 rơi đúng lúc job đang ghi DB sẽ đóng
  // pool giữa chừng.
  let currentJob = null;

  const tasks = SCHEDULES.map(({ name, cron: expr }) => {
    const fn = jobs[name];

    const wrapped = async () => {
      const jobPromise = (async () => {
        try {
          await fn();
        } catch (err) {
          logger.error(`[scheduler] job ${name} lỗi: ${err.stack || err.message}`);
        }
      })();
      currentJob = jobPromise;
      await jobPromise;
      if (currentJob === jobPromise) currentJob = null;
    };

    logger.info(`[scheduler] đăng ký ${name} — ${expr} (${TZ})`);
    return cronLib.schedule(expr, wrapped, { timezone: TZ });
  });

  return {
    stop() { for (const t of tasks) t.stop(); },
    /**
     * Chờ job đang chạy dở (nếu có) xong trước khi cho phép đóng connection
     * pool. `stop()` chỉ ngăn các lần chạy TƯƠNG LAI — node-cron không hủy
     * được callback đang thực thi. Có timeout để một job kẹt không chặn
     * shutdown vô thời hạn; hết timeout thì ghi log và coi như xong.
     */
    async drain(timeoutMs = 30000) {
      const job = currentJob;
      if (!job) return;

      let timer;
      let timedOut = false;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
      });

      // clearTimeout ngay khi race ngã ngũ — nếu KHÔNG làm việc này, một
      // timer 30s vẫn chạy nền dù job đã xong từ lâu, giữ tiến trình sống
      // vô ích cho tới khi nó tự bắn (đây là bug thật đã bắt được lúc viết
      // test: cả bộ test scheduler mất 30s thay vì mili-giây vì thiếu dòng
      // này). Timer KHÔNG unref() — nó phải thật sự có khả năng bắn để
      // đường timeout hoạt động đúng khi job kẹt thật sự không bao giờ xong.
      await Promise.race([job, timeout]);
      clearTimeout(timer);
      if (timedOut) {
        logger.warn(`[scheduler] drain: hết ${timeoutMs}ms chờ job kết thúc, tiếp tục shutdown`);
      }
    },
  };
}
