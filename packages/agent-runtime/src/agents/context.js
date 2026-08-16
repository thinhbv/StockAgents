import { loadPortfolio } from '../sim/portfolio.js';
import { DEFAULT_RISK } from '../sim/guardrails.js';
import { retrieveLessons } from '../memory/retrieval.js';
import { LOT_SIZE } from '../sim/vn_rules.js';
import { FEE_RATE } from '../sim/fees.js';

/**
 * Khối lượng TỐI ĐA mua được một mã mà không chạm hàng rào tiền mặt/tỷ trọng
 * — tính sẵn thay vì để LLM tự chia availableCash/price, vì Haiku 4.5 (và có
 * thể các model nhỏ khác) đã cho thấy tính sai gấp hàng chục-hàng trăm lần
 * trong thực tế (spec: order bị checkBuy từ chối vì "cần 228 tỷ, có 1 tỷ").
 *
 * Đây là TRẦN, không phải gợi ý mục tiêu — persona nói rõ điều này để tránh
 * agent hình thành thói quen luôn mua kịch trần một mã (dồn hết tiền vào một
 * chỗ). Không có giới hạn số LOẠI mã đang giữ — agent tự quyết định dàn trải
 * bao nhiêu mã, hàng rào duy nhất là tiền mặt và tỷ trọng tối đa/mã.
 */
function maxAffordableQty({ priceVnd, cash, nav, maxPositionPctNav }) {
  if (!Number.isFinite(priceVnd) || priceVnd <= 0) return 0;
  const budget = Math.min(cash, (nav * maxPositionPctNav) / 100);
  if (!Number.isFinite(budget) || budget <= 0) return 0;
  // Trừ sẵn phí mua để trần này tự nó không bao giờ bị checkBuy từ chối.
  // FEE_RATE đã là phân số (0.0015 = 0,15%), không phải số phần trăm.
  const qty = Math.floor(budget / (priceVnd * (1 + FEE_RATE)) / LOT_SIZE) * LOT_SIZE;
  return Math.max(0, qty);
}

const NEWS_LOOKBACK_DAYS = 3;
const NEWS_PER_SYMBOL = 5;
const NEWS_MARKET_MAX = 10;

/**
 * Gom tin tức gần đây, TÁCH theo mã và tin chung thị trường (symbol NULL).
 *
 * Chấm điểm bằng từ điển (news/sentiment.js) chỉ đủ để watchdog biết CÓ NÊN
 * đánh thức agent hay không — không phải một bản phân tích. Bản thân agent
 * phải tự đọc tiêu đề/tóm tắt thật và tự đánh giá, đúng chủ đích ban đầu của
 * hệ thống. Trước bản sửa này, context chưa từng đưa tin thật vào — agent chỉ
 * thấy được điểm sentiment qua watchdog, chưa bao giờ đọc được nội dung tin.
 *
 * Một câu truy vấn duy nhất (không phải một câu/mã) rồi nhóm ở client — tổng
 * lượng tin một ngày chỉ vài chục bài (xem ingest_news.js), không đáng để
 * query 30 lần cho 30 mã trong universe.
 */
async function fetchNews(repos) {
  const bySymbol = new Map();
  const market = [];
  if (!repos.news) return { bySymbol, market };

  const since = new Date(Date.now() - NEWS_LOOKBACK_DAYS * 86_400_000);
  const items = await repos.news.listRecent({ since, limit: 200 });
  for (const it of items) {
    if (!it.symbol) {
      if (market.length < NEWS_MARKET_MAX) market.push(it);
      continue;
    }
    if (!bySymbol.has(it.symbol)) bySymbol.set(it.symbol, []);
    const list = bySymbol.get(it.symbol);
    if (list.length < NEWS_PER_SYMBOL) list.push(it);
  }
  return { bySymbol, market };
}

const toContextNews = (n) => ({
  title: n.title, summary: n.summary, sentiment: n.sentiment,
  publishedAt: n.publishedAt, source: n.source,
});

/**
 * Dựng context đưa cho agent.
 *
 * MỌI truy vấn dữ liệu agent đều đi qua repository có assertAgentScope,
 * nên context của agent này không thể chứa dữ liệu của agent khác (spec §3.2).
 */
export async function buildContext({
  repos, agentId, tradeDate, universe, snapshots, priceMap,
  trigger = 'SESSION_OPEN', risk = DEFAULT_RISK, queryVector,
}) {
  const portfolio = await loadPortfolio({ repos, agentId, priceMap });
  const recentTrades = await repos.trading.listTrades(agentId, 20);

  // Bài học chỉ có nếu Phase 6 đã bật; thiếu repo thì context vẫn dựng được.
  const lessons = repos.lessons
    ? await retrieveLessons({ repos, agentId, queryVector })
    : [];

  // repos.market vắng mặt trong test context nhẹ (spec §3.2 kiểu) — context vẫn dựng được.
  const indices = repos.market ? await repos.market.getLatestIndices() : [];
  const news = await fetchNews(repos);
  // Chỉ số cơ bản (P/E, ROE, cổ tức...) — dữ liệu duy nhất hệ thống thiếu hẳn
  // trước bản sửa này (không phải quên nối dây như tin tức, mà chưa từng thu
  // thập). MỘT câu truy vấn cho cả universe, giống news, không phải 30 câu.
  const fundamentals = repos.fundamentals
    ? await repos.fundamentals.getLatestForSymbols(universe.map(u => u.symbol))
    : new Map();

  return {
    asOf: tradeDate,
    trigger,
    market: { indices, news: news.market.map(toContextNews) },
    universe: universe.map(u => {
      const indicators = snapshots.get(u.symbol) ?? {};
      const lastPriceVnd = priceMap.get(u.symbol) ?? null;
      return {
        symbol: u.symbol,
        sector: u.sector ?? null,
        lastPriceVnd,
        // Tin thật của MÃ NÀY — đọc và tự đánh giá, không phải chỉ điểm số.
        news: (news.bySymbol.get(u.symbol) ?? []).map(toContextNews),
        // Chỉ số cơ bản quý gần nhất (P/E, P/B, ROE, ROA, cổ tức, nợ/vốn chủ,
        // vốn hoá) — null nếu chưa ingest được cho mã này, không đoán bừa.
        fundamentals: fundamentals.get(u.symbol) ?? null,
        // TRẦN khối lượng còn mua được cho mã này (đã trừ phí, đã làm tròn lô
        // chẵn) — không phải gợi ý nên mua bao nhiêu. Không dùng hết mức này
        // cho một mã; dàn trải theo mức độ tin tưởng vào từng cơ hội.
        maxAffordableQty: maxAffordableQty({
          priceVnd: lastPriceVnd, cash: portfolio.cash, nav: portfolio.nav,
          maxPositionPctNav: risk.maxPositionPctNav,
        }),
        indicators,
        // Cờ tường minh thay vì để agent tự suy ra từ {} rỗng — và guardrails
        // dùng chính cờ này (không phải đoán lại) để chặn mua khi thiếu dữ liệu.
        indicatorsMissing: Object.keys(indicators).length === 0,
      };
    }),
    portfolio: {
      cash: portfolio.cash,
      nav: portfolio.nav,
      positions: portfolio.positions.map(p => ({
        symbol: p.symbol, qtyTotal: p.qtyTotal, qtySellable: p.qtySellable,
        avgCostVnd: p.avgCostVnd, unrealizedPct: p.unrealizedPct, exitPlan: p.exitPlan,
      })),
    },
    memory: {
      recentTrades: recentTrades.map(t => ({
        symbol: t.symbol, action: t.action, priceVnd: t.priceVnd,
        qty: t.qty, reason: t.reason, decidedAt: t.decidedAt,
      })),
      lessons: lessons.map(l => ({
        id: l.id, lesson: l.lesson, confidence: l.confidence,
      })),
    },
    constraints: {
      // Không có trần số mã mới/phiên hay số vị thế tối đa — agent tự quyết
      // định dàn trải bao nhiêu mã, miễn còn trong tỷ trọng/mã và tiền mặt.
      maxPositionPctNav: risk.maxPositionPctNav,
      minLot: 100,
      availableCash: portfolio.cash,
      tradableSymbols: universe.map(u => u.symbol),
    },
  };
}
