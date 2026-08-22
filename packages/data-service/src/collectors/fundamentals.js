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

// Lãi/lỗ sau thuế (isa20), lợi nhuận về cổ đông công ty mẹ (isa22), EPS
// (isa23) dùng CHUNG mã trường cho mọi loại hình doanh nghiệp — đã kiểm
// chứng thật bằng cách so metrics của FPT (phi tài chính) với VCB (ngân
// hàng): phần cuối báo cáo (từ thuế trở xuống) giống hệt nhau, chỉ phần đầu
// (doanh thu) khác mẫu. Doanh thu thì KHÔNG có một mã trường chung: công ty
// thường dùng isa3 ("Doanh thu thuần"), ngân hàng dùng isb27 ("Thu nhập lãi
// thuần") — không có khái niệm doanh thu bán hàng. Dò theo thứ tự ưu tiên,
// lấy mã ĐẦU TIÊN thật sự có trong metrics của chính mã đó — không đoán bừa
// theo loại hình, để chính API xác nhận công ty này báo cáo dòng nào.
const REVENUE_CODE_CANDIDATES = ['isa3', 'isb27'];
const NET_PROFIT_CODE = 'isa20';
const PARENT_PROFIT_CODE = 'isa22';
const EPS_CODE = 'isa23';

/**
 * Tóm tắt doanh thu/lợi nhuận TUYỆT ĐỐI (không phải tỷ lệ như statistics-
 * financial) — quý gần nhất. Cần gọi CẢ hai endpoint: metrics để biết mã
 * trường nào tồn tại thật và tên tiếng Việt đúng của nó (không hardcode nhãn
 * — một nhãn sai còn tệ hơn không có dữ liệu), và financial-statement để lấy
 * giá trị. Trả `null` nếu không tìm được dòng nào — không đoán bừa.
 */
async function fetchIncomeSummary(symbol, fetchImpl) {
  const ticker = tickerOf(symbol);

  const [metricsRes, dataRes] = await Promise.all([
    fetchImpl(`${BASE_URL}/${ticker}/financial-statement/metrics`, { headers: HEADERS }),
    fetchImpl(`${BASE_URL}/${ticker}/financial-statement?section=INCOME_STATEMENT`, { headers: HEADERS }),
  ]);
  if (!metricsRes.ok || !dataRes.ok) return null;

  const metricsBody = await metricsRes.json();
  const dataBody = await dataRes.json();
  const labelByCode = new Map(
    (metricsBody.data?.INCOME_STATEMENT ?? []).map(m => [m.field, m.titleVi]));

  const quarters = dataBody.data?.quarters;
  if (!Array.isArray(quarters) || quarters.length === 0) return null;
  const latest = quarters.reduce((best, r) => (
    !best || r.yearReport > best.yearReport
      || (r.yearReport === best.yearReport && r.lengthReport > best.lengthReport)
  ) ? r : best, null);

  const revenueCode = REVENUE_CODE_CANDIDATES.find(c => labelByCode.has(c));
  const line = (code) => labelByCode.has(code) && Number.isFinite(latest[code])
    ? { label: labelByCode.get(code), value: latest[code] } : null;

  const summary = {
    yearReport: latest.yearReport, quarter: latest.lengthReport,
    revenue: revenueCode ? line(revenueCode) : null,
    netProfit: line(NET_PROFIT_CODE),
    netProfitParent: line(PARENT_PROFIT_CODE),
    epsBasicVnd: line(EPS_CODE),
  };
  return summary.revenue || summary.netProfit ? summary : null;
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

  // Doanh thu/lợi nhuận tuyệt đối là dữ liệu BỔ SUNG trên nền tỷ lệ đã có —
  // lỗi ở đây (endpoint khác, ít kiểm chứng hơn) không được làm hỏng cả lần
  // ingest, vốn đã thành công với statistics-financial ở trên.
  let incomeStatement = null;
  try {
    incomeStatement = await fetchIncomeSummary(symbol, fetchImpl);
  } catch { /* best-effort — giữ nguyên null */ }

  return { ...pickRatios(latest), incomeStatement };
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
