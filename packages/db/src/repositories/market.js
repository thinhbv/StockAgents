// DATE (oid 1082) được ép trả về nguyên chuỗi 'YYYY-MM-DD' bởi type parser
// đăng ký trong client.js (nơi duy nhất mọi module chạm DB đều import qua) —
// xem client.js để biết lý do. row.trade_date ở đây LUÔN là string; nếu parser
// đó từng bị gỡ, ta muốn lỗi bung ra ngay thay vì âm thầm quay lại đường lùi
// một ngày, nên không có nhánh dự phòng cho Date object.
const num = (v) => (v === null || v === undefined ? null : Number(v));

function toBar(row) {
  return {
    tradeDate: row.trade_date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  };
}

export function createMarketRepo(client) {
  async function upsertOhlcvBars(symbol, bars) {
    if (!bars || bars.length === 0) return 0;
    return client.withTransaction(async (tx) => {
      for (const b of bars) {
        await tx.query(
          `INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (symbol, trade_date) DO UPDATE
             SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                 close = EXCLUDED.close, volume = EXCLUDED.volume`,
          [symbol, b.tradeDate, b.open, b.high, b.low, b.close, b.volume],
        );
      }
      return bars.length;
    });
  }

  async function getLatestBar(symbol) {
    const { rows } = await client.query(
      `SELECT trade_date, open, high, low, close, volume
       FROM ohlcv_daily WHERE symbol = $1 ORDER BY trade_date DESC LIMIT 1`,
      [symbol],
    );
    return rows.length ? toBar(rows[0]) : null;
  }

  async function insertIndicatorSnapshot(symbol, payload) {
    const { rows } = await client.query(
      `INSERT INTO indicator_snapshot (symbol, payload) VALUES ($1, $2) RETURNING id`,
      [symbol, payload],
    );
    return { id: rows[0].id };
  }

  /**
   * Tuổi (phút) của mã CŨ NHẤT trong universe đang bật, không phải mã mới nhất.
   *
   * Đây là hàm mà kiểm tra PRE_OPEN gọi để quyết định có cho agent giao dịch
   * hay không (spec §6.1). Lấy MAX toàn cục là sai: một mã tươi sẽ che 29 mã
   * cũ, và cổng an toàn báo xanh đúng lúc phải chặn.
   *
   * Trả về null khi KHÔNG XÁC ĐỊNH ĐƯỢC độ tươi cho toàn bộ universe — tức là
   * có mã đang bật chưa từng có snapshot nào, hoặc universe rỗng. Consumer
   * phải coi null là "không đủ dữ liệu để giao dịch", chứ không phải "mới tinh".
   */
  async function getLatestIndicatorAgeMinutes() {
    const { rows } = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE latest IS NULL) AS never_captured,
         COUNT(*)                               AS active_symbols,
         EXTRACT(EPOCH FROM (now() - MIN(latest))) / 60 AS age
       FROM (
         SELECT u.symbol, MAX(s.captured_at) AS latest
         FROM universe u
         LEFT JOIN indicator_snapshot s ON s.symbol = u.symbol
         WHERE u.active
         GROUP BY u.symbol
       ) per_symbol`,
    );

    const row = rows[0];
    if (!row || Number(row.active_symbols) === 0) return null;
    if (Number(row.never_captured) > 0) return null;
    return Number(row.age);
  }

  async function insertQuoteTicks(ticks) {
    if (!ticks || ticks.length === 0) return 0;
    return client.withTransaction(async (tx) => {
      for (const t of ticks) {
        await tx.query(
          `INSERT INTO quote_tick (symbol, price, volume) VALUES ($1, $2, $3)`,
          [t.symbol, t.price, t.volume ?? null],
        );
      }
      return ticks.length;
    });
  }

  async function insertIndexSnapshots(indices) {
    if (!indices || indices.length === 0) return 0;
    return client.withTransaction(async (tx) => {
      for (const i of indices) {
        await tx.query(
          `INSERT INTO market_index_snapshot (index_code, value, change_pct)
           VALUES ($1,$2,$3)`, [i.indexCode, i.value, i.changePct ?? null]);
      }
      return indices.length;
    });
  }

  async function getLatestIndices(limit = 10) {
    const { rows } = await client.query(
      `SELECT DISTINCT ON (index_code) index_code AS "indexCode", value,
              change_pct AS "changePct", captured_at AS "capturedAt"
       FROM market_index_snapshot ORDER BY index_code, captured_at DESC LIMIT $1`, [limit]);
    return rows.map(r => ({ ...r, value: Number(r.value), changePct: num(r.changePct) }));
  }

  async function getLatestPrices(symbols) {
    const map = new Map();
    if (!symbols || symbols.length === 0) return map;
    const { rows } = await client.query(
      `SELECT DISTINCT ON (symbol) symbol, price FROM quote_tick
       WHERE symbol = ANY($1) ORDER BY symbol, ts DESC`, [symbols]);
    for (const r of rows) map.set(r.symbol, Number(r.price));
    return map;
  }

  async function getLatestQuotes(symbols) {
    if (!symbols || symbols.length === 0) return [];
    const { rows } = await client.query(
      `SELECT DISTINCT ON (symbol) symbol, price, volume, ts FROM quote_tick
       WHERE symbol = ANY($1) ORDER BY symbol, ts DESC`, [symbols]);
    return rows.map(r => ({
      symbol: r.symbol, price: Number(r.price),
      volume: r.volume === null ? null : Number(r.volume), ts: r.ts,
    }));
  }

  /** Giá tham chiếu = close phiên gần nhất đã có trong ohlcv_daily (thường là hôm trước, vì ingest_prices chạy lúc 8h30 trước giờ mở cửa nên chưa có bar hôm nay). */
  async function getRefPrices(symbols) {
    const map = new Map();
    if (!symbols || symbols.length === 0) return map;
    const { rows } = await client.query(
      `SELECT DISTINCT ON (symbol) symbol, close FROM ohlcv_daily
       WHERE symbol = ANY($1) ORDER BY symbol, trade_date DESC`, [symbols]);
    for (const r of rows) map.set(r.symbol, Number(r.close));
    return map;
  }

  return {
    insertIndexSnapshots, getLatestIndices,
    upsertOhlcvBars, getLatestBar, insertIndicatorSnapshot,
    getLatestIndicatorAgeMinutes, insertQuoteTicks, getLatestPrices, getRefPrices, getLatestQuotes,
  };
}
