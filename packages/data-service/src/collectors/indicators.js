/**
 * Ánh xạ (tên study của TradingView, tiêu đề giá trị) → khóa chuẩn hóa.
 * `getStudyValues` trả về giá trị dạng CHUỖI đã format, nên phải parse.
 */
const FIELD_MAP = [
  ['Relative Strength Index', 'RSI', 'rsi14'],
  ['Moving Average Simple', 'Plot', 'ma20'],
  ['MACD', 'MACD', 'macd'],
  ['MACD', 'Signal', 'macdSignal'],
  ['MACD', 'Histogram', 'macdHist'],
  ['Bollinger Bands', 'Upper', 'bbUpper'],
  ['Bollinger Bands', 'Basis', 'bbBasis'],
  ['Bollinger Bands', 'Lower', 'bbLower'],
  ['Average True Range', 'ATR', 'atr14'],
];

/**
 * Khóa TỐI THIỂU một lần thu thập chỉ báo THÀNH CÔNG phải có. `getStudyValues`
 * không bao giờ ném lỗi (tradingview_mcp/src/core/data.js) — mọi lỗi nội bộ bị
 * nuốt và trả về `{success:true, study_count:0, studies:[]}`, kể cả ngay sau
 * khi đổi symbol khi chart còn đang tính lại study. Không có danh sách khóa
 * bắt buộc này, `parseStudyValues([])` cho `{}` và job sẽ ghi một snapshot
 * rỗng trông giống dữ liệu hợp lệ (Finding 1).
 */
export const REQUIRED_INDICATOR_KEYS = ['rsi14', 'macd', 'bbBasis', 'atr14'];

function parseNumber(raw) {
  if (raw === null || raw === undefined) return undefined;
  // Bỏ dấu phân cách nghìn và ký tự đơn vị (K/M/B TradingView đôi khi thêm vào)
  const cleaned = String(raw).replace(/,/g, '').trim();
  const multiplier = /K$/i.test(cleaned) ? 1e3
                   : /M$/i.test(cleaned) ? 1e6
                   : /B$/i.test(cleaned) ? 1e9 : 1;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value * multiplier : undefined;
}

export function parseStudyValues(studies) {
  const parsed = {};
  for (const [studyName, valueTitle, key] of FIELD_MAP) {
    const study = (studies || []).find(s => s.name === studyName);
    if (!study) continue;
    const value = parseNumber(study.values?.[valueTitle]);
    if (value !== undefined) parsed[key] = value;
  }
  return parsed;
}

export async function collectIndicators(broker, symbol) {
  const result = await broker.withSymbol(symbol, (core) => core.data.getStudyValues());
  const raw = result?.studies ?? [];
  const parsed = parseStudyValues(raw);

  const missing = REQUIRED_INDICATOR_KEYS.filter(key => parsed[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `collectIndicators: ${symbol} thiếu khóa chỉ báo bắt buộc: ${missing.join(', ')}`);
  }

  return { raw, parsed };
}
