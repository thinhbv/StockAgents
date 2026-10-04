/**
 * Giá tick + lịch sử OHLC từ API công khai Vietcap (VCI) — HTTP thuần, KHÔNG
 * qua CDP/TradingView Desktop. Cùng host/headers đã kiểm chứng thật trong
 * collectors/intraday_flow.js; xem comment ở đó để biết nguồn gốc endpoint
 * (đọc mã nguồn thư viện mở `vnstock`).
 *
 * Thay cho collectors/prices.js + collectors/quotes.js (đường CDP cũ) — bỏ
 * hẳn phụ thuộc TradingView Desktop, gốc rễ của cả một lớp lỗi đã gặp: tiến
 * trình treo/zombie khi CDP kẹt, panel giá đọc nhầm mã trong lúc chuyển
 * chart (xem bug ACB 2026-08-25: tick 25.350đ trong khi giá thật chỉ quanh
 * 22.200-22.700đ suốt phiên — cùng nguồn API này đã xác nhận đúng).
 */
import { toVnDate } from '../lib/vn_time.js';

const TRADING_URL = 'https://trading.vietcap.com.vn/api';
const TIMEOUT_MS = 15_000;

const HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'Referer': 'https://trading.vietcap.com.vn/',
  'Origin': 'https://trading.vietcap.com.vn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

/** VCI nhận ticker trần ("FPT"), hệ thống lưu mã có tiền tố sàn ("HOSE:FPT"). */
function tickerOf(symbol) {
  const idx = symbol.indexOf(':');
  return idx === -1 ? symbol : symbol.slice(idx + 1);
}

/**
 * fetch() gốc không có timeout — một yêu cầu treo (đã thấy thật: endpoint
 * gap-chart có lúc chậm bất thường) sẽ chờ MÃI MÃI, đúng lớp lỗi "tiến trình
 * treo" đã tốn rất nhiều công sửa ở nhánh CDP cũ. AbortController buộc nó
 * phải thất bại RÕ RÀNG sau TIMEOUT_MS thay vì treo im lặng.
 */
async function fetchWithTimeout(fetchImpl, url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`hết ${TIMEOUT_MS}ms chờ phản hồi`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Giá khớp + trần/sàn/tham chiếu CHÍNH THỨC từ sàn cho CẢ universe trong
 * MỘT lần gọi — không cần tự tính priceBand() từ giá đóng cửa hôm trước
 * nữa, VCI trả thẳng ceilingPrice/floorPrice/referencePrice của đúng phiên
 * đang giao dịch.
 *
 * Một mã lỗi (không có trong response, hoặc thiếu matchPrice) KHÔNG được
 * làm hỏng cả batch — trả riêng mảng errors, cùng quy ước với mọi collector
 * khác trong hệ thống.
 */
export async function collectVciQuotes(symbols, fetchImpl = fetch) {
  const ticks = [];
  const errors = [];
  if (symbols.length === 0) return { ticks, errors };

  const tickerToSymbol = new Map(symbols.map(s => [tickerOf(s), s]));
  const res = await fetchWithTimeout(fetchImpl, `${TRADING_URL}/price/symbols/getList`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ symbols: [...tickerToSymbol.keys()] }),
  }).catch(err => { throw new Error(`collectVciQuotes: ${err.message}`); });
  if (!res.ok) throw new Error(`collectVciQuotes: HTTP ${res.status}`);

  const rows = await res.json();
  const seen = new Set();
  for (const r of rows) {
    const ticker = r.listingInfo?.symbol ?? r.matchPrice?.symbol;
    const symbol = tickerToSymbol.get(ticker);
    if (!symbol) continue;
    seen.add(symbol);

    const mp = r.matchPrice ?? {};
    const price = Number(mp.matchPrice);
    if (!Number.isFinite(price) || price <= 0) {
      errors.push({ symbol, message: `collectVciQuotes: giá khớp không hợp lệ: ${mp.matchPrice}` });
      continue;
    }
    ticks.push({
      symbol, price,
      volume: Number.isFinite(mp.accumulatedVolume) ? Math.round(mp.accumulatedVolume) : null,
      ceiling: Number.isFinite(mp.ceilingPrice) ? mp.ceilingPrice : null,
      floor: Number.isFinite(mp.floorPrice) ? mp.floorPrice : null,
      refPrice: Number.isFinite(mp.referencePrice) ? mp.referencePrice : null,
    });
  }

  for (const symbol of symbols) {
    if (!seen.has(symbol)) errors.push({ symbol, message: 'collectVciQuotes: không có trong response' });
  }

  return { ticks, errors };
}

const DEFAULT_SLEEP = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Lịch sử bar ngày cho MỘT mã. Endpoint này (khác price/symbols/getList)
 * KHÔNG nhận mảng symbols — đã thử, response rỗng — nên phải gọi riêng
 * từng mã như collectRecentFlow trong intraday_flow.js. Gọi 30 lần liên tiếp
 * không nghỉ (một lần ingest hết universe) đã thấy VÀI mã cuối bị timeout —
 * nghi giới hạn tốc độ phía server — nên có retry ngắn, không phải vòng lặp
 * gọi trần như price/symbols/getList (chỉ gọi 1 lần cho cả universe).
 *
 * `countBack` là tham số BẮT BUỘC — thiếu nó API trả 400 dù from/to đã có
 * (đã kiểm chứng thật, không có trong tài liệu công khai nào).
 */
export async function collectVciDailyBars(symbol, {
  count = 60, fetchImpl = fetch, maxRetries = 3, baseDelayMs = 1000, sleep = DEFAULT_SLEEP,
} = {}) {
  const to = Math.floor(Date.now() / 1000);
  let lastErr;
  let rows;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(fetchImpl, `${TRADING_URL}/chart/OHLCChart/gap-chart`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({
          timeFrame: 'ONE_DAY', symbols: [tickerOf(symbol)], countBack: count, to,
        }),
      }).catch(err => { throw new Error(`collectVciDailyBars: ${symbol} ${err.message}`); });
      if (!res.ok) throw new Error(`collectVciDailyBars: ${symbol} HTTP ${res.status}`);
      rows = await res.json();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) await sleep(baseDelayMs * attempt);
    }
  }
  if (lastErr) throw lastErr;

  const row = rows[0];
  if (!row || !Array.isArray(row.t) || row.t.length === 0) {
    throw new Error(`collectVciDailyBars: ${symbol} không có bar nào trả về`);
  }

  const bars = [];
  for (let i = 0; i < row.t.length; i++) {
    const tradeDate = toVnDate(Number(row.t[i]));
    const raw = { open: row.o[i], high: row.h[i], low: row.l[i], close: row.c[i], volume: row.v[i] ?? 0 };
    const bar = {
      tradeDate,
      open: Number(raw.open), high: Number(raw.high), low: Number(raw.low), close: Number(raw.close),
      volume: Math.round(Number(raw.volume)),
    };
    for (const field of ['open', 'high', 'low', 'close', 'volume']) {
      if (!Number.isFinite(bar[field])) {
        throw new Error(
          `collectVciDailyBars: ${symbol} ngày ${tradeDate} có trường '${field}' không hợp lệ: ${raw[field]}`);
      }
    }
    bars.push(bar);
  }
  return bars;
}
