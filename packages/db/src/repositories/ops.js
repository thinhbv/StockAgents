export function createOpsRepo(client) {
  async function setSessionState(tradeDate, state, { dataCapturedAt = null, note = null } = {}) {
    await client.query(
      `INSERT INTO session_state (trade_date, state, data_captured_at, note, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (trade_date) DO UPDATE
         SET state = EXCLUDED.state,
             data_captured_at = COALESCE(EXCLUDED.data_captured_at, session_state.data_captured_at),
             note = EXCLUDED.note,
             updated_at = now()`,
      [tradeDate, state, dataCapturedAt, note],
    );
  }

  async function getSessionState(tradeDate) {
    const { rows } = await client.query(
      `SELECT trade_date, state, data_captured_at, note, updated_at
       FROM session_state WHERE trade_date = $1`,
      [tradeDate],
    );
    return rows[0] ?? null;
  }

  async function logIngestError(job, symbol, message) {
    await client.query(
      `INSERT INTO ingest_errors (job, symbol, message) VALUES ($1, $2, $3)`,
      [job, symbol, String(message).slice(0, 2000)],
    );
  }

  async function countIngestErrorsSince(since) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM ingest_errors WHERE occurred_at >= $1`,
      [since],
    );
    return rows[0].n;
  }

  /**
   * Lịch nghỉ lễ dưới dạng Set các chuỗi 'YYYY-MM-DD'.
   *
   * Trả về Set chứ không phải mảng vì phía gọi tra cứu mỗi nhịp poll —
   * và `isTradingDay` nhận cả hai kiểu.
   */
  async function listHolidays() {
    const { rows } = await client.query(
      `SELECT holiday_date FROM market_holidays ORDER BY holiday_date`);
    // holiday_date là DATE, type parser trong client.js giữ nguyên chuỗi.
    return new Set(rows.map(r => r.holiday_date));
  }

  return {
    setSessionState, getSessionState, logIngestError, countIngestErrorsSince,
    listHolidays,
  };
}
