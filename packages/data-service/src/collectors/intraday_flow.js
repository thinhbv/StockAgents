/**
 * VWAP thật, order book (bid/ask), khối ngoại mua/bán ròng, và áp lực chủ
 * động mua/bán trong các lệnh khớp gần nhất — API công khai Vietcap (VCI),
 * endpoint và header xác định qua đọc mã nguồn thư viện mở `vnstock`
 * (vnstock/explorer/vci/quote.py, const.py), đã kiểm chứng gọi thật.
 * KHÔNG qua CDP/TradingView Desktop — nguồn độc lập.
 *
 * Hai nguồn khác nhau, gộp vào MỘT snapshot:
 *   - price/symbols/getList: BATCH cả universe trong MỘT lần gọi (đã kiểm
 *     chứng) — VWAP thật (avgMatchPrice, không phải tự tính lại), order book
 *     3 mức giá, khối ngoại mua/bán ròng (foreignBuyVolume/foreignSellVolume).
 *   - market-watch/LEData/getAll: CHỈ theo từng mã, trả tối đa 100 lệnh khớp
 *     gần nhất mỗi lần gọi (đã kiểm chứng: xin 5000 vẫn chỉ được 100) —
 *     dùng để đo áp lực mua/bán chủ động trên TAPE, khác với order book (đang
 *     chờ khớp) — đặt tên field rõ "recent" để không đánh lừa agent nghĩ đây
 *     là số liệu cả phiên.
 */
const TRADING_URL = 'https://trading.vietcap.com.vn/api';

const HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'Referer': 'https://trading.vietcap.com.vn/',
  'Origin': 'https://trading.vietcap.com.vn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const MAX_PRINTS = 100;

/** VCI nhận ticker trần ("FPT"), hệ thống lưu mã có tiền tố sàn ("HOSE:FPT"). */
function tickerOf(symbol) {
  const idx = symbol.indexOf(':');
  return idx === -1 ? symbol : symbol.slice(idx + 1);
}

const emptyBoard = () => ({ vwapVnd: null, bids: [], asks: [], foreignNet: null });

/**
 * Board thời gian thực cho CẢ universe trong MỘT lần gọi — không query
 * riêng từng mã (khác LEData, endpoint này chấp nhận mảng symbols thật).
 */
export async function collectBoardSnapshot(symbols, fetchImpl = fetch) {
  const bySymbol = new Map();
  if (symbols.length === 0) return bySymbol;

  const tickerToSymbol = new Map(symbols.map(s => [tickerOf(s), s]));
  const res = await fetchImpl(`${TRADING_URL}/price/symbols/getList`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ symbols: [...tickerToSymbol.keys()] }),
  });
  if (!res.ok) throw new Error(`collectBoardSnapshot: HTTP ${res.status}`);

  const rows = await res.json();
  for (const r of rows) {
    const symbol = tickerToSymbol.get(r.listingInfo?.symbol);
    if (!symbol) continue;
    const mp = r.matchPrice ?? {};
    const ba = r.bidAsk ?? {};
    bySymbol.set(symbol, {
      vwapVnd: Number.isFinite(mp.avgMatchPrice) ? Math.round(mp.avgMatchPrice) : null,
      bids: (ba.bidPrices ?? []).map(b => ({ price: b.price, volume: b.volume })),
      asks: (ba.askPrices ?? []).map(a => ({ price: a.price, volume: a.volume })),
      foreignNet: Number.isFinite(mp.foreignBuyVolume) && Number.isFinite(mp.foreignSellVolume)
        ? {
          buyVolume: mp.foreignBuyVolume, sellVolume: mp.foreignSellVolume,
          buyValueVnd: mp.foreignBuyValue, sellValueVnd: mp.foreignSellValue,
        } : null,
    });
  }
  return bySymbol;
}

/**
 * Áp lực mua/bán chủ động trên TAPE (lệnh đã khớp), trong tối đa 100 lệnh
 * khớp gần nhất của MỘT mã — endpoint này không nhận mảng symbols.
 */
export async function collectRecentFlow(symbol, fetchImpl = fetch) {
  const res = await fetchImpl(`${TRADING_URL}/market-watch/LEData/getAll`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ symbol: tickerOf(symbol), limit: MAX_PRINTS }),
  });
  if (!res.ok) throw new Error(`collectRecentFlow: ${symbol} HTTP ${res.status}`);

  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`collectRecentFlow: ${symbol} không có dữ liệu`);
  }

  let recentBuyVolume = 0, recentSellVolume = 0;
  for (const r of rows) {
    const vol = Number(r.matchVol);
    if (!Number.isFinite(vol)) continue;
    if (r.matchType === 'b') recentBuyVolume += vol;
    else if (r.matchType === 's') recentSellVolume += vol;
  }

  return { recentBuyVolume, recentSellVolume, recentPrintCount: rows.length };
}

/**
 * Gộp board (batch, best-effort — lỗi cả loạt thì mọi mã đều thiếu VWAP/
 * order book/khối ngoại, không chặn phần recent flow riêng từng mã) với
 * recent flow (riêng từng mã, lỗi của một mã vào errors[] như mọi collector
 * khác trong hệ thống).
 */
export async function collectIntradayFlowBatch(symbols, fetchImpl = fetch) {
  let board = new Map();
  try {
    board = await collectBoardSnapshot(symbols, fetchImpl);
  } catch { /* best-effort — mọi mã dùng emptyBoard() bên dưới */ }

  const snapshots = [];
  const errors = [];
  for (const symbol of symbols) {
    try {
      const recent = await collectRecentFlow(symbol, fetchImpl);
      snapshots.push({ symbol, payload: { ...(board.get(symbol) ?? emptyBoard()), ...recent } });
    } catch (err) {
      errors.push({ symbol, message: err.message });
    }
  }
  return { snapshots, errors };
}
