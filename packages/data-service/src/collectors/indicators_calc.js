/**
 * Tính chỉ báo kỹ thuật từ chuỗi OHLCV — HÀM THUẦN.
 *
 * Vì sao không đọc từ TradingView: `getStudyValues()` lấy giá trị từ Data
 * Window, mà TradingView chỉ điền khi con trỏ nằm trên chart. Chạy tự động
 * lúc 8h30 không có ai ngồi trước máy thì nó trả về rỗng — đã kiểm chứng
 * trên chart thật: chart có RSI nhưng `getStudyValues()` chỉ trả `["Volume"]`.
 *
 * Tự tính từ `ohlcv_daily` gỡ bỏ hẳn phụ thuộc đó, và cho ra kết quả tất
 * định, test được bằng bảng số liệu.
 *
 * Bars truyền vào phải xếp CŨ TRƯỚC MỚI SAU.
 */

/**
 * Bốn khoá mà một snapshot chỉ báo PHẢI có mới được coi là dùng được.
 * Thiếu bất kỳ khoá nào thì mã đó tính là thất bại — một snapshot khuyết
 * trông giống dữ liệu hợp lệ nhưng không phải.
 */
export const REQUIRED_INDICATOR_KEYS = ['rsi14', 'macd', 'bbBasis', 'atr14'];

function requireBars(bars, need, fn) {
  if (!Array.isArray(bars)) throw new Error(`${fn}: cần mảng bars`);
  return bars.length >= need;
}

const round = (v, d = 4) => {
  const m = 10 ** d;
  return Math.round(v * m) / m;
};

/** Trung bình động đơn giản của `period` phần tử cuối. */
export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return round(slice.reduce((a, b) => a + b, 0) / period);
}

/**
 * Trung bình động luỹ thừa. Mồi bằng SMA của `period` phần tử đầu — cách
 * TradingView và hầu hết thư viện làm, để giá trị hội tụ giống nhau.
 */
export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return round(prev);
}

/**
 * RSI theo Wilder: sau lần khởi tạo, trung bình được làm mượt bằng
 * `(prev * (n-1) + current) / n` chứ không phải trung bình cộng thường.
 * Dùng nhầm công thức cho ra RSI lệch vài điểm — đủ để đảo ngược một
 * quyết định quanh ngưỡng 30/70.
 */
export function rsi(closes, period = 14) {
  if (!requireBars(closes, period + 1, 'rsi')) return null;

  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return round(100 - 100 / (1 + rs), 2);
}

/** MACD = EMA nhanh − EMA chậm; signal là EMA của chính đường MACD. */
export function macd(closes, { fast = 12, slow = 26, signal = 9 } = {}) {
  if (!requireBars(closes, slow + signal, 'macd')) return null;

  const line = [];
  for (let i = slow; i <= closes.length; i++) {
    const win = closes.slice(0, i);
    line.push(ema(win, fast) - ema(win, slow));
  }
  const sig = ema(line, signal);
  if (sig === null) return null;

  const macdValue = line[line.length - 1];
  return {
    macd: round(macdValue),
    macdSignal: round(sig),
    macdHist: round(macdValue - sig),
  };
}

/** Bollinger Bands: SMA ± k lần độ lệch chuẩn TOÀN PHẦN (chia n, không n−1). */
export function bollinger(closes, { period = 20, mult = 2 } = {}) {
  if (!requireBars(closes, period, 'bollinger')) return null;

  const win = closes.slice(-period);
  const basis = win.reduce((a, b) => a + b, 0) / period;
  const variance = win.reduce((a, b) => a + (b - basis) ** 2, 0) / period;
  const sd = Math.sqrt(variance);

  return {
    bbBasis: round(basis),
    bbUpper: round(basis + mult * sd),
    bbLower: round(basis - mult * sd),
  };
}

/** ATR theo Wilder, trên true range = max(H−L, |H−Cprev|, |L−Cprev|). */
export function atr(bars, period = 14) {
  if (!requireBars(bars, period + 1, 'atr')) return null;

  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }

  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]) / period;
  return round(value);
}

/**
 * Gộp mọi chỉ báo thành đúng hình dạng `indicator_snapshot.payload` mà
 * Phase 2 và Phase 5 đã đọc — khóa giữ nguyên để không phải sửa gì phía sau.
 */
export function computeIndicators(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return {};

  const closes = bars.map(b => Number(b.close));
  const out = {};

  const r = rsi(closes, 14);
  if (r !== null) out.rsi14 = r;

  const ma = sma(closes, 20);
  if (ma !== null) out.ma20 = ma;

  const m = macd(closes);
  if (m) Object.assign(out, m);

  const bb = bollinger(closes);
  if (bb) Object.assign(out, bb);

  const a = atr(bars, 14);
  if (a !== null) out.atr14 = a;

  const vols = bars.map(b => Number(b.volume)).filter(Number.isFinite);
  if (vols.length > 0) out.volume = vols[vols.length - 1];
  const vma = sma(vols, 20);
  if (vma !== null) out.volumeMa20 = Math.round(vma);

  return out;
}
