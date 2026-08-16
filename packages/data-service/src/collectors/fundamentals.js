/**
 * Chỉ số tài chính cơ bản (P/E, P/B, ROE, ROA, cổ tức, nợ/vốn chủ...) từ API
 * công khai của Vietcap (VCI) — không cần key, không cần tài khoản. Endpoint
 * và header xác định qua việc đọc mã nguồn thư viện mở `vnstock`
 * (vnstock/explorer/vci/financial.py, const.py), đã kiểm chứng gọi thật.
 *
 * Một mã lỗi KHÔNG được làm hỏng cả batch — cùng khuôn với collectQuotes:
 * trả riêng mảng errors, job gọi quyết định ghi log thế nào.
 */
const BASE_URL = 'https://iq.vietcap.com.vn/api/iq-insight-service/v1/company';

const HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  // Vietcap chỉ chặn theo Referer/Origin/User-Agent trông giống trình duyệt
  // (không có API key/OAuth) — thiếu các header này thường bị từ chối.
  'Referer': 'https://trading.vietcap.com.vn/',
  'Origin': 'https://trading.vietcap.com.vn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// Chỉ giữ field thật sự dùng để phân tích. Endpoint trả thêm nhiều field chỉ
// có nghĩa với ngân hàng (car, casaRatio, npl, ldrLoanDepositRatio...) — luôn
// null/0 với công ty phi tài chính, đưa vào context chỉ tổ tốn chỗ mà LLM
// phải tự lọc ra.
function pickRatios(r) {
  return {
    yearReport: r.yearReport, quarter: r.quarter,
    pe: r.pe, pb: r.pb, ps: r.ps, roe: r.roe, roa: r.roa,
    dividendYield: r.dividendYield, debtToEquity: r.debtToEquity,
    currentRatio: r.currentRatio, grossMargin: r.grossMargin,
    marketCap: r.marketCap,
  };
}

/** VCI nhận ticker trần ("FPT"), hệ thống lưu mã có tiền tố sàn ("HOSE:FPT"). */
function tickerOf(symbol) {
  const idx = symbol.indexOf(':');
  return idx === -1 ? symbol : symbol.slice(idx + 1);
}

/**
 * Fetch chỉ số quý MỚI NHẤT cho một mã. Endpoint trả cả chuỗi lịch sử từ
 * 2018 (nhiều chục quý) — agent chỉ cần bức tranh hiện tại, không cần lịch
 * sử tài chính, nên chỉ giữ lại bản ứng với (yearReport, quarter) lớn nhất.
 * Không tin thứ tự mảng trả về — tự so sánh thay vì lấy phần tử cuối.
 */
export async function collectFundamentals(symbol, fetchImpl = fetch) {
  const res = await fetchImpl(`${BASE_URL}/${tickerOf(symbol)}/statistics-financial`, { headers: HEADERS });
  if (!res.ok) throw new Error(`collectFundamentals: ${symbol} HTTP ${res.status}`);

  const body = await res.json();
  const rows = body.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`collectFundamentals: ${symbol} không có dữ liệu`);
  }

  const latest = rows.reduce((best, r) => (
    !best || r.yearReport > best.yearReport
      || (r.yearReport === best.yearReport && r.quarter > best.quarter)
  ) ? r : best, null);

  return pickRatios(latest);
}

export async function collectFundamentalsBatch(symbols, fetchImpl = fetch) {
  const snapshots = [];
  const errors = [];
  for (const symbol of symbols) {
    try {
      snapshots.push({ symbol, payload: await collectFundamentals(symbol, fetchImpl) });
    } catch (err) {
      errors.push({ symbol, message: err.message });
    }
  }
  return { snapshots, errors };
}
