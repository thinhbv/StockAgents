/**
 * Báo cáo cuối phiên qua Telegram.
 *
 * Chỉ ĐỌC từ database rồi gửi đi — không quyết định gì, không ghi gì. Nếu
 * Telegram chết, phiên giao dịch vẫn hoàn tất bình thường.
 */
const API = 'https://api.telegram.org';

const vnd = (n) => (n === null || n === undefined) ? '—' : Math.round(n).toLocaleString('vi-VN');

export function formatLeaderboard({ tradeDate, agents }) {
  const lines = [`*Tổng kết phiên ${tradeDate}*`, ''];

  if (agents.length === 0) {
    lines.push('Không agent nào giao dịch.');
    return lines.join('\n');
  }

  for (const [i, a] of agents.entries()) {
    const pct = a.totalReturnPct;
    const mark = pct === null ? '·' : (pct > 0 ? '▲' : pct < 0 ? '▼' : '·');
    lines.push(
      `${i + 1}. *${a.name}* ${mark} ${pct === null ? '—' : `${pct}%`}\n` +
      `   NAV ${vnd(a.nav)}đ · ${a.positionCount} vị thế`);
  }

  const best = agents[0];
  const worst = agents[agents.length - 1];
  if (agents.length > 1 && best.totalReturnPct !== null && worst.totalReturnPct !== null) {
    lines.push('', `Chênh lệch dẫn đầu: ${Math.round((best.totalReturnPct - worst.totalReturnPct) * 100) / 100} điểm %`);
  }
  return lines.join('\n');
}

export function createTelegramReporter({ token, chatId, fetchImpl = fetch, logger = console }) {
  const enabled = Boolean(token && chatId);
  if (!enabled) {
    logger.info('[telegram] thiếu TELEGRAM_TOKEN hoặc TELEGRAM_CHAT_ID — bỏ qua báo cáo');
  }

  async function post(text, parseMode) {
    const body = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    const res = await fetchImpl(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
  }

  async function send(text) {
    if (!enabled) return { sent: false, reason: 'chưa cấu hình' };
    try {
      // text có thể là lời đáp tự do của LLM (agent điều phối), không đảm bảo
      // là Markdown hợp lệ (một dấu * hoặc _ lẻ cũng làm Telegram từ chối cả
      // tin nhắn) — lỗi "can't parse entities" thì gửi lại dạng chữ thường,
      // không mất tin nhắn chỉ vì định dạng.
      try {
        await post(text, 'Markdown');
      } catch (err) {
        if (!/can't parse entities/i.test(err.message)) throw err;
        await post(text);
      }
      return { sent: true };
    } catch (err) {
      // Báo cáo hỏng không được làm hỏng phiên. Ghi log rồi đi tiếp.
      logger.warn(`[telegram] gửi thất bại: ${err.message}`);
      return { sent: false, reason: err.message };
    }
  }

  async function reportDay({ routes, tradeDate }) {
    const { agents } = await routes.leaderboard({ query: {} });
    return send(formatLeaderboard({ tradeDate, agents }));
  }

  return { send, reportDay, enabled };
}
