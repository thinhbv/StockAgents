import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MAX_LIMIT = 500;

const DEFAULT_AGENTS_CONFIG_PATH =
  fileURLToPath(new URL('../../../config/agents.json', import.meta.url));
const DEFAULT_MODEL_CATALOG_PATH =
  fileURLToPath(new URL('../../../config/model-catalog.json', import.meta.url));

export class HttpError extends Error {
  constructor(status, message) { super(`${status}: ${message}`); this.status = status; }
}

function intParam(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

export function createRoutes({
  client, repos,
  agentsConfigPath = DEFAULT_AGENTS_CONFIG_PATH,
  modelCatalogPath = DEFAULT_MODEL_CATALOG_PATH,
}) {

  async function session({ query = {} }) {
    const date = query.date ?? new Date().toISOString().slice(0, 10);
    const s = await repos.ops.getSessionState(date);
    if (!s) {
      // Không có dữ liệu thì nói thẳng là không biết. Trả 'DATA_READY' cho
      // một ngày chưa ingest là đúng loại nói dối mà cả hệ thống này tránh.
      return { date, state: 'UNKNOWN', dataCapturedAt: null, note: null };
    }
    return { date, state: s.state, dataCapturedAt: s.data_captured_at, note: s.note };
  }

  async function leaderboard() {
    const { rows } = await client.query(
      `SELECT a.id, a.name, a.provider, a.model, a.initial_capital AS "initialCapital",
              s.nav, s.cash, s.market_value AS "marketValue", s.day_pnl AS "dayPnl",
              (SELECT count(*) FROM positions p
               WHERE p.agent_id = a.id AND p.closed_at IS NULL) AS "positionCount"
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT nav, cash, market_value, day_pnl FROM portfolio_snapshot
         WHERE agent_id = a.id ORDER BY snap_date DESC LIMIT 1
       ) s ON TRUE
       WHERE a.active
       ORDER BY s.nav DESC NULLS LAST, a.id`);

    // Bảng đọc DB (provider/model ĐANG CHẠY THẬT), nhưng sửa trên dashboard
    // chỉ ghi vào agents.json — nếu không kèm theo giá trị đang chờ áp dụng,
    // người vừa sửa sẽ thấy bảng "vẫn model cũ" và tưởng thao tác không ăn.
    const pendingById = new Map(
      (await readFile(agentsConfigPath, 'utf8').then(JSON.parse).catch(() => []))
        .map(d => [d.id, { provider: d.provider, model: d.model }]));

    return {
      agents: rows.map(r => {
        const nav = r.nav === null ? null : Number(r.nav);
        const cap = Number(r.initialCapital);
        const pending = pendingById.get(r.id);
        const isPending = !!pending && (pending.provider !== r.provider || pending.model !== r.model);
        return {
          id: r.id, name: r.name, provider: r.provider, model: r.model,
          isPending, pendingProvider: isPending ? pending.provider : null,
          pendingModel: isPending ? pending.model : null,
          initialCapital: cap,
          nav,
          cash: r.cash === null ? null : Number(r.cash),
          marketValue: r.marketValue === null ? null : Number(r.marketValue),
          dayPnl: r.dayPnl === null ? null : Number(r.dayPnl),
          positionCount: Number(r.positionCount),
          totalReturnPct: nav === null ? null
            : Math.round(((nav - cap) / cap) * 10000) / 100,
        };
      }),
    };
  }

  async function agent({ params }) {
    const a = await repos.agents.get(params.id);
    if (!a) throw new HttpError(404, `không có agent '${params.id}'`);
    return a;
  }

  async function positions({ params }) {
    const list = await repos.trading.getOpenPositions(params.id);
    const priceMap = await repos.market.getLatestPrices(list.map(p => p.symbol));
    return {
      agentId: params.id,
      positions: list.map(p => {
        const lastPriceVnd = priceMap.get(p.symbol) ?? p.avgCostVnd;
        const unrealizedPct = p.avgCostVnd > 0
          ? Math.round(((lastPriceVnd - p.avgCostVnd) / p.avgCostVnd) * 10000) / 100
          : 0;
        return { ...p, lastPriceVnd, unrealizedPct };
      }),
    };
  }

  async function decisions({ params, query = {} }) {
    const limit = intParam(query.limit, 50, MAX_LIMIT);
    return { agentId: params.id, decisions: await repos.trading.listTrades(params.id, limit) };
  }

  async function lessons({ params, query = {} }) {
    const limit = intParam(query.limit, 50, MAX_LIMIT);
    const list = await repos.lessons.listActive(params.id, limit);
    return {
      agentId: params.id,
      lessons: list.map(l => ({
        id: l.id, lesson: l.lesson, confidence: l.confidence,
        timesRetrieved: l.timesRetrieved, timesHelped: l.timesHelped,
      })),
    };
  }

  /**
   * Chuỗi NAV theo ngày + bộ chỉ số mới nhất, cho biểu đồ trên dashboard.
   *
   * Loại bỏ mốc 1970: đó là bản ghi vốn ban đầu do engine tạo để so sánh
   * PnL, không phải một phiên giao dịch. Vẽ nó lên sẽ cho một đường thẳng
   * dài 56 năm rồi mới tới dữ liệu thật.
   *
   * Truy vấn lấy N ngày GẦN NHẤT (DESC + LIMIT) rồi đảo lại — lấy ASC + LIMIT
   * sẽ cắt mất phần mới nhất, đúng phần người xem quan tâm.
   */
  async function history({ params, query = {} }) {
    const agentRow = await repos.agents.get(params.id);
    if (!agentRow) throw new HttpError(404, `không có agent '${params.id}'`);

    const limit = intParam(query.limit, 90, MAX_LIMIT);
    const { rows } = await client.query(
      `SELECT snap_date AS "snapDate", nav, cash, market_value AS "marketValue",
              day_pnl AS "dayPnl"
       FROM portfolio_snapshot
       WHERE agent_id = $1 AND snap_date > DATE '1970-01-01'
       ORDER BY snap_date DESC LIMIT $2`, [params.id, limit]);

    const { rows: mrows } = await client.query(
      `SELECT snap_date AS "snapDate", total_return_pct AS "totalReturnPct",
              win_rate AS "winRate", sharpe, max_drawdown AS "maxDrawdown",
              avg_holding_days AS "avgHoldingDays", trade_count AS "tradeCount",
              confidence_calibration AS "confidenceCalibration"
       FROM metrics_daily WHERE agent_id = $1
       ORDER BY snap_date DESC LIMIT 1`, [params.id]);

    const n = (v) => (v === null || v === undefined ? null : Number(v));
    const m = mrows[0];

    return {
      agentId: params.id,
      initialCapital: Number(agentRow.initialCapital),
      series: rows.reverse().map(r => ({
        snapDate: r.snapDate,
        nav: n(r.nav), cash: n(r.cash),
        marketValue: n(r.marketValue), dayPnl: n(r.dayPnl),
      })),
      metrics: m ? {
        snapDate: m.snapDate, totalReturnPct: n(m.totalReturnPct),
        winRate: n(m.winRate), sharpe: n(m.sharpe), maxDrawdown: n(m.maxDrawdown),
        avgHoldingDays: n(m.avgHoldingDays), tradeCount: m.tradeCount,
        confidenceCalibration: n(m.confidenceCalibration),
      } : null,
    };
  }

  async function events({ query = {} }) {
    const since = intParam(query.since, 0);
    const limit = intParam(query.limit, 200, MAX_LIMIT);
    return { events: await repos.events.getEventsSince(since, limit) };
  }

  async function modelCatalog() {
    return JSON.parse(await readFile(modelCatalogPath, 'utf8'));
  }

  /**
   * Provider/model ĐANG CHỜ ÁP DỤNG (đọc từ config/agents.json) bên cạnh
   * provider/model ĐANG CHẠY THẬT (đọc từ DB, qua repos.agents.get).
   *
   * Hai nguồn này lệch nhau có chủ đích: sửa trên dashboard chỉ ghi vào
   * agents.json, DB chỉ được ghi đè ở đầu lần `sim:all` kế tiếp. Route
   * `GET /api/agents/:id` (đọc DB) vẫn đúng cho bảng xếp hạng — nó phải
   * phản ánh cấu hình THẬT đang chạy. Nhưng dùng đúng route đó để tô lại
   * form sửa thì sai: F5 xong sửa lại sẽ luôn thấy giá trị DB cũ, không
   * bao giờ thấy lần sửa gần nhất của mình. Route này tồn tại để form biết
   * tô đúng giá trị đã lưu, và để hiện rõ "đang chờ áp dụng" khi hai nguồn lệch nhau.
   */
  async function agentConfig({ params }) {
    const activeRow = await repos.agents.get(params.id);
    if (!activeRow) throw new HttpError(404, `không có agent '${params.id}'`);

    const defs = JSON.parse(await readFile(agentsConfigPath, 'utf8'));
    const pendingDef = defs.find(d => d.id === params.id);
    const pending = pendingDef
      ? { provider: pendingDef.provider, model: pendingDef.model }
      : { provider: activeRow.provider, model: activeRow.model };
    const active = { provider: activeRow.provider, model: activeRow.model };

    return {
      id: params.id, active, pending,
      isPending: active.provider !== pending.provider || active.model !== pending.model,
    };
  }

  /**
   * Sửa provider/model của một agent trong config/agents.json — KHÔNG đụng
   * DB. sim:all/sim:day đọc lại file này và ghi đè vào DB mỗi lần chạy, nên
   * thay đổi ở đây tự động có hiệu lực từ phiên kế tiếp mà không cần đồng bộ
   * ngược, và không xung đột với việc file luôn là nguồn dữ liệu gốc.
   */
  async function updateAgentConfig({ params, body }) {
    const { provider, model } = body ?? {};
    if (typeof provider !== 'string' || typeof model !== 'string') {
      throw new HttpError(400, 'cần cả provider và model dạng chuỗi');
    }

    const catalog = await modelCatalog();
    const models = catalog[provider];
    if (!models) {
      throw new HttpError(400,
        `provider không hợp lệ: '${provider}'. Hỗ trợ: ${Object.keys(catalog).join(', ')}`);
    }
    if (!models.includes(model)) {
      throw new HttpError(400,
        `model '${model}' không thuộc provider '${provider}'. Hỗ trợ: ${models.join(', ')}`);
    }

    const defs = JSON.parse(await readFile(agentsConfigPath, 'utf8'));
    const idx = defs.findIndex(d => d.id === params.id);
    if (idx === -1) throw new HttpError(404, `không có agent '${params.id}' trong config/agents.json`);

    defs[idx] = { ...defs[idx], provider, model };

    // Ghi ra file tạm rồi rename đè — tránh agents.json bị hỏng dở nếu tiến
    // trình chết giữa lúc ghi.
    const tmpPath = `${agentsConfigPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(defs, null, 2)}\n`, 'utf8');
    await rename(tmpPath, agentsConfigPath);

    return { id: params.id, provider, model, appliesFrom: 'phiên chạy tiếp theo' };
  }

  /**
   * Sửa riskConfig (maxPositionPctNav, dailyLossLimitPct) của một agent —
   * cùng con đường ghi an toàn với updateAgentConfig: chỉ đụng
   * config/agents.json, không đụng DB, áp dụng từ phiên chạy tiếp theo.
   *
   * Chỉ ghi đè field NÀO thực sự được truyền — gọi với chỉ một field không
   * được vô tình xoá field còn lại (ví dụ agent điều phối chỉ muốn đổi
   * dailyLossLimitPct thì maxPositionPctNav phải giữ nguyên).
   */
  async function updateAgentRisk({ params, body }) {
    const { maxPositionPctNav, dailyLossLimitPct } = body ?? {};
    if (maxPositionPctNav === undefined && dailyLossLimitPct === undefined) {
      throw new HttpError(400, 'cần ít nhất một trong hai: maxPositionPctNav hoặc dailyLossLimitPct');
    }
    if (maxPositionPctNav !== undefined
        && (typeof maxPositionPctNav !== 'number' || maxPositionPctNav <= 0 || maxPositionPctNav > 100)) {
      throw new HttpError(400, `maxPositionPctNav phải trong khoảng (0, 100], nhận: ${maxPositionPctNav}`);
    }
    if (dailyLossLimitPct !== undefined
        && (typeof dailyLossLimitPct !== 'number' || dailyLossLimitPct <= 0 || dailyLossLimitPct > 100)) {
      throw new HttpError(400, `dailyLossLimitPct phải trong khoảng (0, 100], nhận: ${dailyLossLimitPct}`);
    }

    const defs = JSON.parse(await readFile(agentsConfigPath, 'utf8'));
    const idx = defs.findIndex(d => d.id === params.id);
    if (idx === -1) throw new HttpError(404, `không có agent '${params.id}' trong config/agents.json`);

    const nextRisk = {
      ...defs[idx].riskConfig,
      ...(maxPositionPctNav !== undefined ? { maxPositionPctNav } : {}),
      ...(dailyLossLimitPct !== undefined ? { dailyLossLimitPct } : {}),
    };
    defs[idx] = { ...defs[idx], riskConfig: nextRisk };

    const tmpPath = `${agentsConfigPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(defs, null, 2)}\n`, 'utf8');
    await rename(tmpPath, agentsConfigPath);

    return { id: params.id, riskConfig: nextRisk, appliesFrom: 'phiên chạy tiếp theo' };
  }

  return {
    session, leaderboard, agent, positions, decisions, lessons, events, history,
    modelCatalog, agentConfig, updateAgentConfig, updateAgentRisk,
  };
}
