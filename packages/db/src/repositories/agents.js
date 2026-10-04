import { assertAgentScope } from './_guard.js';

const num = (v) => (v === null || v === undefined ? null : Number(v));

export function createAgentsRepo(client) {
  async function upsertMany(list) {
    for (const a of list) {
      // `active` đồng bộ MỘT CHIỀU từ config/agents.json xuống DB mỗi lần
      // chạy (CLI gọi upsertMany này mỗi lượt watch:tick) — tạm dừng/mở lại
      // một agent chỉ cần sửa trường này trong config, không đụng tới DB
      // tay. Mặc định TRUE khi agent không khai báo trường này (tương thích
      // ngược với config cũ chưa có khái niệm tạm dừng).
      const active = a.active !== false;
      await client.query(
        `INSERT INTO agents (id, name, provider, model, persona_prompt, initial_capital, risk_config, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, provider = EXCLUDED.provider, model = EXCLUDED.model,
           persona_prompt = EXCLUDED.persona_prompt, risk_config = EXCLUDED.risk_config,
           active = EXCLUDED.active`,
        [a.id, a.name, a.provider, a.model, a.personaPrompt, a.initialCapital, a.riskConfig ?? {}, active],
      );
      // Tiền mặt khởi tạo — chỉ đặt khi agent còn mới tinh, để chạy lại
      // upsertMany (CLI làm việc này mỗi lần) không nạp lại tiền cho agent
      // đang có vị thế.
      await client.query(
        `UPDATE agents SET cash_vnd = $2 WHERE id = $1 AND cash_vnd = 0`,
        [a.id, a.initialCapital],
      );
      // Snapshot mốc bất biến ở 1970-01-01: chuẩn so sánh PnL cho phiên đầu.
      await client.query(
        `INSERT INTO portfolio_snapshot (agent_id, snap_date, cash, market_value, nav, day_pnl)
         VALUES ($1, DATE '1970-01-01', $2, 0, $2, 0)
         ON CONFLICT (agent_id, snap_date) DO NOTHING`,
        [a.id, a.initialCapital],
      );
    }
    return list.length;
  }

  async function get(agentId) {
    const id = assertAgentScope(agentId, 'get');
    const { rows } = await client.query(
      `SELECT id, name, provider, model, persona_prompt AS "personaPrompt",
              initial_capital AS "initialCapital", risk_config AS "riskConfig", active
       FROM agents WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    return { ...rows[0], initialCapital: num(rows[0].initialCapital) };
  }

  async function listActive() {
    const { rows } = await client.query(`SELECT id FROM agents WHERE active ORDER BY id`);
    return rows.map(r => r.id);
  }

  // Tiền mặt là TRẠNG THÁI hiện tại, nằm trên agents — KHÔNG lấy từ snapshot.
  // Đọc/ghi qua snapshot sẽ làm hỏng chính mốc so sánh PnL ngày.
  async function getCash(agentId) {
    const id = assertAgentScope(agentId, 'getCash');
    const { rows } = await client.query(
      `SELECT cash_vnd FROM agents WHERE id = $1`, [id]);
    return rows[0] ? num(rows[0].cash_vnd) : null;
  }

  async function setCash(agentId, vnd) {
    const id = assertAgentScope(agentId, 'setCash');
    if (!Number.isFinite(vnd)) throw new Error(`setCash: cash không hợp lệ: ${vnd}`);
    if (vnd < 0) throw new Error(`setCash: tiền mặt âm (${vnd}) — không có đòn bẩy`);
    const { rowCount } = await client.query(
      `UPDATE agents SET cash_vnd = $2 WHERE id = $1`, [id, vnd]);
    if (rowCount === 0) throw new Error(`setCash: không tìm thấy agent ${id}`);
  }

  async function saveSnapshot(agentId, snapDate, { cash, marketValue, nav, dayPnl }) {
    const id = assertAgentScope(agentId, 'saveSnapshot');
    await client.query(
      `INSERT INTO portfolio_snapshot (agent_id, snap_date, cash, market_value, nav, day_pnl)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (agent_id, snap_date) DO UPDATE SET
         cash = EXCLUDED.cash, market_value = EXCLUDED.market_value,
         nav = EXCLUDED.nav, day_pnl = EXCLUDED.day_pnl`,
      [id, snapDate, cash, marketValue, nav, dayPnl]);
  }

  function toSnapshot(row) {
    if (!row) return null;
    return {
      cash: num(row.cash), marketValue: num(row.marketValue),
      nav: num(row.nav), dayPnl: num(row.dayPnl),
    };
  }

  async function getSnapshot(agentId, snapDate) {
    const id = assertAgentScope(agentId, 'getSnapshot');
    const { rows } = await client.query(
      `SELECT cash, market_value AS "marketValue", nav, day_pnl AS "dayPnl"
       FROM portfolio_snapshot WHERE agent_id = $1 AND snap_date = $2`, [id, snapDate]);
    return toSnapshot(rows[0]);
  }

  /**
   * Snapshot của phiên TRƯỚC `beforeDate`. Mốc so sánh cho PnL ngày phải là
   * phiên trước, không phải snapshot cùng ngày — nếu lấy cùng ngày thì chạy
   * lại lần hai sẽ luôn cho dayPnl = 0.
   */
  async function getPreviousSnapshot(agentId, beforeDate) {
    const id = assertAgentScope(agentId, 'getPreviousSnapshot');
    const { rows } = await client.query(
      `SELECT cash, market_value AS "marketValue", nav, day_pnl AS "dayPnl"
       FROM portfolio_snapshot
       WHERE agent_id = $1 AND snap_date < $2
       ORDER BY snap_date DESC LIMIT 1`, [id, beforeDate]);
    return toSnapshot(rows[0]);
  }

  /**
   * Chuỗi NAV theo thứ tự thời gian, BỎ mốc 1970-01-01.
   * Mốc đó là vốn ban đầu, không phải một phiên giao dịch — tính vào chuỗi
   * lợi suất sẽ tạo ra một "ngày" giả giữa vốn ban đầu và phiên đầu tiên.
   */
  async function listNavSeries(agentId) {
    const id = assertAgentScope(agentId, 'listNavSeries');
    const { rows } = await client.query(
      `SELECT nav FROM portfolio_snapshot
       WHERE agent_id = $1 AND snap_date > DATE '1970-01-01'
       ORDER BY snap_date ASC`, [id]);
    return rows.map(r => num(r.nav));
  }

  async function saveMetrics(agentId, snapDate, m) {
    const id = assertAgentScope(agentId, 'saveMetrics');
    await client.query(
      `INSERT INTO metrics_daily
         (agent_id, snap_date, total_return_pct, win_rate, sharpe,
          max_drawdown, avg_holding_days, trade_count, confidence_calibration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (agent_id, snap_date) DO UPDATE SET
         total_return_pct = EXCLUDED.total_return_pct, win_rate = EXCLUDED.win_rate,
         sharpe = EXCLUDED.sharpe, max_drawdown = EXCLUDED.max_drawdown,
         avg_holding_days = EXCLUDED.avg_holding_days, trade_count = EXCLUDED.trade_count,
         confidence_calibration = EXCLUDED.confidence_calibration`,
      [id, snapDate, m.totalReturnPct, m.winRate, m.sharpe,
       m.maxDrawdown, m.avgHoldingDays, m.tradeCount, m.confidenceCalibration]);
  }

  async function getMetrics(agentId, snapDate) {
    const id = assertAgentScope(agentId, 'getMetrics');
    const { rows } = await client.query(
      `SELECT total_return_pct AS "totalReturnPct", win_rate AS "winRate", sharpe,
              max_drawdown AS "maxDrawdown", avg_holding_days AS "avgHoldingDays",
              trade_count AS "tradeCount", confidence_calibration AS "confidenceCalibration"
       FROM metrics_daily WHERE agent_id = $1 AND snap_date = $2`, [id, snapDate]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      totalReturnPct: num(r.totalReturnPct), winRate: num(r.winRate), sharpe: num(r.sharpe),
      maxDrawdown: num(r.maxDrawdown), avgHoldingDays: num(r.avgHoldingDays),
      tradeCount: r.tradeCount, confidenceCalibration: num(r.confidenceCalibration),
    };
  }

  return {
    upsertMany, get, listActive, getCash, setCash,
    saveSnapshot, getSnapshot, getPreviousSnapshot,
    listNavSeries, saveMetrics, getMetrics,
  };
}
