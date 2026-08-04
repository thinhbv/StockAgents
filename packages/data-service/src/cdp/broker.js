/**
 * CDP Broker — điểm truy cập DUY NHẤT tới TradingView (spec §3.1, §5.1).
 *
 * TradingView Desktop có một chart hoạt động duy nhất và `setSymbol` đổi trạng
 * thái toàn cục. Hai lời gọi song song sẽ đọc nhầm dữ liệu của nhau. Broker
 * tuần tự hóa mọi truy cập bằng promise-chain mutex.
 *
 * `core` được truyền vào (dependency injection) để test được mà không cần
 * TradingView đang chạy — `core/data.js` không hỗ trợ tham số `_deps`.
 */

export class BrokerError extends Error {
  constructor(message, { symbol, attempts, cause } = {}) {
    super(message);
    this.name = 'BrokerError';
    this.symbol = symbol ?? null;
    this.attempts = attempts ?? 0;
    this.cause = cause;
  }
}

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

export function createBroker({
  core,
  logger = console,
  maxRetries = 3,
  baseDelayMs = 500,
  sleep = defaultSleep,
  // Thời gian chờ chart chuyển mã. Cấu hình được để test không phải chờ
  // đồng hồ thật — với sleep giả, vòng poll sẽ quay nóng hết khoảng này.
  symbolTimeoutMs = 10_000,
  symbolPollMs = 200,
} = {}) {
  if (!core) throw new Error('createBroker: cần truyền core');

  let chain = Promise.resolve();
  let queued = 0;
  let completed = 0;
  let failed = 0;

  /**
   * Mã định danh (ticker) của một symbol, bỏ tiền tố sàn.
   *
   * TradingView chuẩn hoá 'HOSE:FPT' thành 'HOSE_DLY:FPT' (feed dữ liệu trễ),
   * nên so khớp chuỗi nguyên vẹn KHÔNG BAO GIỜ đúng. So theo ticker mới là
   * thứ thực sự cần biết: chart đang mở đúng mã hay chưa.
   */
  function tickerOf(symbol) {
    const s = String(symbol ?? '');
    return (s.includes(':') ? s.slice(s.indexOf(':') + 1) : s).toUpperCase();
  }

  /**
   * Chờ chart chuyển sang đúng mã, hỏi qua CHART API.
   *
   * Thay cho waitForChartReady mặc định của tradingview_mcp, vốn đọc symbol
   * từ DOM `[data-name="legend-source-title"]`. Sau khi ensureStudies thêm
   * chỉ báo lên chart, phần tử đó hiển thị tên CHỈ BÁO ('RSI') chứ không còn
   * là mã — nên phép so khớp của nó không bao giờ thành công.
   */
  async function waitForSymbol(symbol, { timeoutMs = symbolTimeoutMs, pollMs = symbolPollMs } = {}) {
    const want = tickerOf(symbol);

    // Giới hạn bằng SỐ VÒNG, không bằng đồng hồ tường. `sleep` được tiêm vào
    // để test điều khiển nhịp; nếu chặn theo đồng hồ thì với sleep giả vòng
    // lặp sẽ quay nóng đúng bằng khoảng chờ thật.
    const maxPolls = Math.max(1, Math.ceil(timeoutMs / pollMs));

    for (let i = 0; i < maxPolls; i++) {
      try {
        const state = await core.chart.getState();
        if (tickerOf(state?.symbol) === want) return true;
      } catch {
        // Chart chưa dựng xong — thử lại ở vòng sau.
      }
      await sleep(pollMs);
    }
    return false;
  }

  /** Nối việc vào cuối hàng đợi. Việc lỗi không làm đứt chuỗi. */
  function enqueue(job) {
    queued++;
    const result = chain.then(job, job);
    chain = result.then(() => {}, () => {});
    return result.finally(() => { queued--; });
  }

  async function run(fn) {
    return enqueue(async () => {
      const value = await fn(core);
      completed++;
      return value;
    });
  }

  async function withSymbol(symbol, fn) {
    return enqueue(async () => {
      let lastError;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const switched = await core.chart.setSymbol({
            symbol,
            _deps: { waitForChartReady: () => waitForSymbol(symbol) },
          });
          if (!switched || switched.chart_ready === false) {
            throw new Error(
              `setSymbol ${symbol}: chart không chuyển sang mã này trong thời gian chờ`);
          }
          const value = await fn(core);
          completed++;
          return value;
        } catch (err) {
          lastError = err;
          logger.warn(`[broker] ${symbol} lần ${attempt}/${maxRetries} lỗi: ${err.message}`);
          if (attempt < maxRetries) await sleep(baseDelayMs * 2 ** (attempt - 1));
        }
      }
      failed++;
      throw new BrokerError(
        `Bỏ qua ${symbol} sau ${maxRetries} lần thử: ${lastError.message}`,
        { symbol, attempts: maxRetries, cause: lastError },
      );
    });
  }

  async function isConnected() {
    const state = await core.health.healthCheck();
    return !!(state && state.api_available);
  }

  async function ensureConnected() {
    try {
      if (await isConnected()) return true;
      logger.warn('[broker] CDP đã kết nối nhưng chart API chưa sẵn sàng, thử launch TradingView');
    } catch (err) {
      logger.warn(`[broker] CDP không khả dụng (${err.message}), thử launch TradingView`);
    }
    try {
      await core.health.launch();
      return await isConnected();
    } catch (launchErr) {
      logger.error(`[broker] launch thất bại: ${launchErr.message}`);
      return false;
    }
  }

  return { run, withSymbol, ensureConnected, stats: () => ({ queued, completed, failed }) };
}
