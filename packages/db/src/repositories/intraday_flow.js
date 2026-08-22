/**
 * VWAP và tín hiệu lệnh khớp gần nhất (chủ động mua/bán) — dữ liệu THỊ TRƯỜNG
 * dùng chung cho mọi agent, không thuộc về ai — không assertAgentScope, giống
 * fundamentals.js/news.js. Cùng khuôn bản chụp JSONB theo mã.
 */
export function createIntradayFlowRepo(client) {
  async function insertSnapshot(symbol, payload) {
    const { rows } = await client.query(
      `INSERT INTO intraday_flow_snapshot (symbol, payload) VALUES ($1, $2) RETURNING id`,
      [symbol, payload]);
    return { id: rows[0].id };
  }

  async function getLatest(symbol) {
    const { rows } = await client.query(
      `SELECT payload FROM intraday_flow_snapshot
       WHERE symbol = $1 ORDER BY captured_at DESC LIMIT 1`, [symbol]);
    return rows[0] ? rows[0].payload : null;
  }

  /**
   * Bản mới nhất cho NHIỀU mã trong một câu truy vấn — context.js dựng cho
   * cả universe (~30 mã) mỗi phiên, không nên query riêng từng mã.
   */
  async function getLatestForSymbols(symbols) {
    if (!symbols || symbols.length === 0) return new Map();
    const { rows } = await client.query(
      `SELECT DISTINCT ON (symbol) symbol, payload FROM intraday_flow_snapshot
       WHERE symbol = ANY($1) ORDER BY symbol, captured_at DESC`, [symbols]);
    return new Map(rows.map(r => [r.symbol, r.payload]));
  }

  return { insertSnapshot, getLatest, getLatestForSymbols };
}
