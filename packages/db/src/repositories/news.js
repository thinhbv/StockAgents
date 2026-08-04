const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Tin tức là dữ liệu THỊ TRƯỜNG, không thuộc về agent nào — nên không có
 * assertAgentScope ở đây. Mọi agent đọc cùng một dòng tin, giống như ngoài đời.
 */
export function createNewsRepo(client) {
  async function upsertMany(items) {
    if (!items || items.length === 0) return 0;
    let n = 0;
    for (const it of items) {
      // url là khoá tự nhiên: cùng một bài đăng lại không được đếm hai lần.
      const { rowCount } = await client.query(
        `INSERT INTO news_items (symbol, source, url, title, summary, sentiment, published_at, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (url) DO UPDATE SET
           title = EXCLUDED.title, summary = EXCLUDED.summary,
           sentiment = COALESCE(EXCLUDED.sentiment, news_items.sentiment)`,
        [it.symbol ?? null, it.source, it.url, it.title, it.summary ?? null,
         it.sentiment ?? null, it.publishedAt ?? null,
         it.embedding ? JSON.stringify(it.embedding) : null]);
      n += rowCount;
    }
    return n;
  }

  async function listRecent({ symbol = null, since = null, limit = 50 } = {}) {
    const { rows } = await client.query(
      `SELECT id, symbol, source, url, title, summary, sentiment,
              published_at AS "publishedAt"
       FROM news_items
       WHERE ($1::text IS NULL OR symbol = $1)
         AND ($2::timestamptz IS NULL OR published_at >= $2)
       ORDER BY published_at DESC NULLS LAST, id DESC
       LIMIT $3`, [symbol, since, limit]);
    return rows.map(r => ({ ...r, sentiment: num(r.sentiment) }));
  }

  /**
   * Sentiment tệ nhất gần đây cho mỗi mã — thứ watchdog cần để quyết định
   * có đánh thức agent vì tin xấu hay không. Lấy MIN chứ không lấy trung bình:
   * một tin rất xấu bị ba tin trung tính pha loãng sẽ không còn đánh thức ai.
   */
  async function worstSentimentBySymbol({ since }) {
    const { rows } = await client.query(
      `SELECT symbol, MIN(sentiment) AS worst FROM news_items
       WHERE symbol IS NOT NULL AND sentiment IS NOT NULL AND published_at >= $1
       GROUP BY symbol`, [since]);
    return new Map(rows.map(r => [r.symbol, Number(r.worst)]));
  }

  return { upsertMany, listRecent, worstSentimentBySymbol };
}
