/**
 * Giả lập tradingview-mcp/core cho test.
 * Ghi lại thứ tự lời gọi để kiểm chứng broker thực sự tuần tự hóa.
 */
// TradingView CHUẨN HOÁ symbol: 'HOSE:ACB' -> 'HOSE_DLY:ACB' (feed dữ liệu trễ).
// Fake phải phản ánh điều đó, nếu không test sẽ "chứng minh" phép so khớp
// symbol là đúng trong khi thực tế nó không bao giờ khớp.
const defaultNormalizer = (s) => String(s).replace(/^([A-Z]+):/, '$1_DLY:');

export function createFakeCore({
  failFirst = 0, delayMs = 0, healthy = true, apiAvailable = true,
  chartReady = true, studiesReady = true, symbolNormalizer = defaultNormalizer,
} = {}) {
  const calls = [];
  let failures = failFirst;
  let currentSymbol = null;      // mã ĐÃ YÊU CẦU — dùng cho nhật ký lời gọi
  let reportedSymbol = null;     // mã CHART BÁO VỀ — đã chuẩn hoá
  let launchCount = 0;
  let healthyNow = healthy;
  let apiAvailableNow = apiAvailable;
  let chartReadyNow = chartReady;
  let studiesReadyNow = studiesReady;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  return {
    calls,
    get currentSymbol() { return currentSymbol; },
    get launchCount() { return launchCount; },
    setHealthy(v) { healthyNow = v; },
    setApiAvailable(v) { apiAvailableNow = v; },
    setChartReady(v) { chartReadyNow = v; },
    setStudiesReady(v) { studiesReadyNow = v; },

    chart: {
      async setSymbol({ symbol, _deps }) {
        calls.push(`setSymbol:${symbol}`);
        if (delayMs) await sleep(delayMs);
        currentSymbol = symbol;
        // chartReady=false nghĩa là chart KHÔNG chuyển được sang mã mới —
        // mô hình đúng của thực tế, thay vì chỉ trả một cờ rỗng.
        if (chartReadyNow) reportedSymbol = symbolNormalizer(symbol);

        // Người gọi tiêm phép kiểm tra sẵn sàng riêng thì dùng nó — đúng như
        // chart.setSymbol thật làm qua _deps.
        if (_deps?.waitForChartReady) {
          const ready = await _deps.waitForChartReady(symbol);
          return { success: true, symbol, chart_ready: ready };
        }
        return { success: true, symbol, chart_ready: chartReadyNow };
      },
      async setTimeframe({ timeframe }) {
        calls.push(`setTimeframe:${timeframe}`);
        return { success: true };
      },
      async getState() {
        calls.push('getState');
        // Chart báo về mã ĐÃ CHUẨN HOÁ, không phải mã ta yêu cầu.
        return { success: true, symbol: reportedSymbol, studies: [] };
      },
      async manageIndicator({ action, indicator, inputs }) {
        calls.push(`manageIndicator:${action}:${indicator}` + (inputs ? `:${JSON.stringify(inputs)}` : ''));
        return { success: true };
      },
    },

    data: {
      async getOhlcv({ count }) {
        calls.push(`getOhlcv:${currentSymbol}:${count}`);
        if (failures > 0) { failures--; throw new Error('Could not extract OHLCV data'); }
        if (delayMs) await sleep(delayMs);

        // Trả ĐÚNG số bar được yêu cầu, như TradingView thật. Chỉ báo cần
        // tối thiểu 35 bar; fake chỉ trả 2 bar sẽ khiến mọi test ingest
        // thất bại vì lý do không liên quan đến thứ nó định kiểm chứng.
        const n = Math.max(1, Math.min(count ?? 100, 500));
        const DAY = 86_400;
        const start = 1784592000 - (n - 1) * DAY;   // 2026-07-21 lùi về trước
        const bars = [];
        for (let i = 0; i < n; i++) {
          const base = 100 + Math.sin(i / 3) * 5 + i * 0.1;
          bars.push({
            time: start + i * DAY,
            open: base, high: base + 1.5, low: base - 1.5, close: base + 0.5,
            volume: 1000 + i,
          });
        }
        return { success: true, bar_count: bars.length, bars };
      },
      async getStudyValues() {
        calls.push(`getStudyValues:${currentSymbol}`);
        if (!studiesReadyNow) {
          // Mirrors tradingview_mcp/src/core/data.js:324-358 getStudyValues — it
          // NEVER throws; every internal failure is swallowed and it resolves
          // with an empty study list, e.g. right after setSymbol while the
          // chart is still recomputing studies.
          return { success: true, study_count: 0, studies: [] };
        }
        return {
          success: true, study_count: 5,
          studies: [
            { name: 'Relative Strength Index', values: { RSI: '62.53', 'RSI-based MA': '58.10' } },
            { name: 'Moving Average Simple', values: { Plot: '105.20' } },
            { name: 'MACD', values: { MACD: '1.25', Signal: '0.98', Histogram: '0.27' } },
            { name: 'Bollinger Bands', values: { Upper: '115.0', Basis: '105.0', Lower: '95.0' } },
            { name: 'Average True Range', values: { ATR: '2.35' } },
          ],
        };
      },
      async getQuote() {
        calls.push(`getQuote:${currentSymbol}`);
        // Mirrors tradingview_mcp/src/core/data.js:245 getQuote — no `price`
        // field on the real response; `last` and `close` come from the same
        // bar value, and it throws if neither is present.
        // Giá lệch theo TỪNG mã (không hằng số) — một fake trả cùng giá cho
        // mọi mã sẽ không bao giờ bắt được bug thật đã xảy ra: CDP đọc dính
        // giá cũ, nhiều mã khác nhau cùng ra một con số trong một lượt poll.
        const s = String(currentSymbol ?? '');
        const base = 100 + (s.charCodeAt(s.length - 1) % 50);
        return {
          success: true,
          symbol: currentSymbol,
          time: 1784678400,
          open: base - 3, high: base + 4, low: base - 4, close: base, last: base,
          volume: 500,
        };
      },
    },

    health: {
      async healthCheck() {
        calls.push('healthCheck');
        if (!healthyNow) throw new Error('CDP not connected');
        // Mirrors tradingview_mcp/src/core/health.js:8 healthCheck — it
        // catches chart-API errors internally and RESOLVES with
        // api_available: false rather than rejecting, e.g. right after
        // launch() while TradingView is still loading its chart.
        return { success: true, cdp_connected: true, api_available: apiAvailableNow };
      },
      async launch() {
        calls.push('launch');
        launchCount++;
        healthyNow = true;
        return { success: true };
      },
    },
  };
}
