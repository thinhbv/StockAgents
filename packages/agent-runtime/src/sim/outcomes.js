import { buyCost, sellProceeds } from './fees.js';

/**
 * Ghép lệnh mua với lệnh bán thành vòng trọn vẹn (round-trip) theo FIFO.
 *
 * Đây là thứ mở khoá 5 trong 6 metric của spec §10 — không biết lệnh nào lãi
 * lệnh nào lỗ thì không tính được win rate, Sharpe, max drawdown, thời gian
 * giữ trung bình. Và lesson scorer cũng đứng im vì nó cần biết kết quả.
 *
 * FIFO chứ không phải bình quân: khớp với cách `consumeLots` tiêu lô, để
 * PnL của một vòng khớp với tiền mặt thực tế đã đổi tay.
 */

const DAY_MS = 86_400_000;

/**
 * Ghép một lệnh BÁN với các lệnh MUA chưa khớp hết, cũ trước.
 *
 * `openBuys` là mảng `{ tradeId, qtyRemaining, priceVnd, decidedAt }` — được
 * sửa tại chỗ để lần gọi sau thấy phần đã tiêu.
 */
export function matchSell({ sell, openBuys }) {
  const rounds = [];
  let left = sell.qty;

  for (const buy of openBuys) {
    if (left <= 0) break;
    if (buy.qtyRemaining <= 0) continue;

    const qty = Math.min(left, buy.qtyRemaining);
    buy.qtyRemaining -= qty;
    left -= qty;

    // PnL tính TRÊN TIỀN THỰC: giá mua cộng phí, giá bán trừ phí và thuế.
    // Bỏ qua phí sẽ cho ra một vòng "hoà vốn" trong khi thực tế đang lỗ.
    const cost = buyCost({ priceVnd: buy.priceVnd, qty }).total;
    const proceeds = sellProceeds({ priceVnd: sell.priceVnd, qty }).net;
    const pnl = proceeds - cost;

    rounds.push({
      entryTradeId: buy.tradeId,
      exitTradeId: sell.tradeId,
      symbol: sell.symbol,
      qty,
      entryPriceVnd: buy.priceVnd,
      exitPriceVnd: sell.priceVnd,
      pnl,
      pnlPct: Math.round((pnl / cost) * 10000) / 100,
      holdingDays: Math.max(0, Math.floor(
        (new Date(sell.decidedAt).getTime() - new Date(buy.decidedAt).getTime()) / DAY_MS)),
    });
  }

  if (left > 0) {
    // Bán nhiều hơn số đã mua — engine đã chặn ở guardrail, nhưng nếu lọt tới
    // đây thì phải kêu lên chứ không âm thầm bỏ qua phần dư.
    throw new Error(
      `matchSell: ${sell.symbol} bán ${sell.qty} nhưng chỉ ghép được ${sell.qty - left}`);
  }
  return rounds;
}

/**
 * Quét toàn bộ lịch sử lệnh của một agent và ghi các vòng chưa được ghi.
 * Idempotent: vòng đã ghi rồi thì bỏ qua, nên chạy lại cuối mỗi phiên an toàn.
 */
export async function recordOutcomes({ repos, agentId, logger = console }) {
  // listTrades trả mới nhất trước; đảo lại để ghép theo trình tự thời gian.
  const trades = (await repos.trading.listTrades(agentId, 1000)).slice().reverse();
  const existing = await repos.trading.listOutcomeExitIds(agentId);

  const openBySymbol = new Map();
  const toWrite = [];

  for (const t of trades) {
    if (t.action === 'BUY') {
      if (!openBySymbol.has(t.symbol)) openBySymbol.set(t.symbol, []);
      openBySymbol.get(t.symbol).push({
        tradeId: t.id, qtyRemaining: t.qty, priceVnd: t.priceVnd, decidedAt: t.decidedAt,
      });
      continue;
    }

    const openBuys = openBySymbol.get(t.symbol) ?? [];
    let rounds;
    try {
      // listTrades trả trường `id`; matchSell nhận `tradeId`. Truyền thẳng
      // object trade vào sẽ cho exitTradeId = undefined, và phép kiểm tra
      // idempotent không bao giờ khớp — vòng bị ghi lại mỗi lần chạy.
      rounds = matchSell({
        sell: {
          tradeId: t.id, symbol: t.symbol, qty: t.qty,
          priceVnd: t.priceVnd, decidedAt: t.decidedAt,
        },
        openBuys,
      });
    } catch (err) {
      logger.warn(`[outcomes] ${agentId}: ${err.message}`);
      continue;
    }
    // Vẫn phải chạy matchSell để openBuys tiêu đúng phần, nhưng chỉ GHI
    // những vòng chưa có — nếu không, chạy lại sẽ nhân đôi.
    if (!existing.has(t.id)) toWrite.push(...rounds);
  }

  for (const r of toWrite) await repos.trading.insertOutcome(agentId, r);
  if (toWrite.length > 0) {
    logger.info(`[outcomes] ${agentId}: ghi ${toWrite.length} vòng giao dịch`);
  }
  return { written: toWrite.length, rounds: toWrite };
}
