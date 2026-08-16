import {
  createAgentsRepo, createTradingRepo, createUniverseRepo, createMarketRepo, createNewsRepo,
  createFundamentalsRepo,
} from '@stockagents/db';
import { toVnd } from './sim/vn_rules.js';
import { createEngine } from './sim/engine.js';
import { createRunner } from './agents/runner.js';
import { buildContext } from './agents/context.js';
import { refreshSellable } from './sim/portfolio.js';
import { closeSession } from './sim/pnl.js';
import { DEFAULT_RISK } from './sim/guardrails.js';

/**
 * Chạy trọn một phiên giả lập cho MỘT agent.
 *
 * Giá đọc từ DB ở đơn vị TradingView (nghìn đồng) và chuyển sang VND đúng
 * MỘT lần tại đây, qua toVnd(). Mọi thứ sau điểm này đều là VND.
 */
export async function runSession({
  client, agentId, tradeDate, provider, agentDef, logger = console, priceOverride,
}) {
  const repos = {
    agents: createAgentsRepo(client),
    trading: createTradingRepo(client),
    universe: createUniverseRepo(client),
    market: createMarketRepo(client),
    news: createNewsRepo(client),
    fundamentals: createFundamentalsRepo(client),
  };

  const universe = await repos.universe.listActive();
  const built = await buildPriceMaps(client, universe);
  const refPriceMap = built.refPriceMap;

  // `priceOverride` cho phép người gọi chỉ định giá tại THỜI ĐIỂM mở phiên.
  // Không có nó, buildPriceMaps luôn lấy tick MỚI NHẤT — đúng khi chạy trực
  // tiếp lúc 09:15, nhưng sai khi phát lại cả ngày: agent sẽ mua ở giá cuối
  // ngày rồi mọi nhịp sau trông như đang lỗ.
  const tickPriceMap = priceOverride ?? built.tickPriceMap;

  if (tickPriceMap.size === 0) {
    logger.warn(`[session] ${agentId}: không có dữ liệu giá cho ngày ${tradeDate}`);
    return { status: 'NO_DATA', agentId, tradeDate, decisions: [], invalid: [], results: [], close: null };
  }

  // T+2: mở khoá các lô đã về tài khoản trước khi agent nhìn danh mục.
  await refreshSellable({ repos, agentId, today: tradeDate });

  const snapshots = await buildIndicatorMap(client, universe);
  const def = agentDef ?? (await repos.agents.get(agentId));
  const risk = def?.riskConfig ?? DEFAULT_RISK;

  const context = await buildContext({
    repos, agentId, tradeDate,
    universe: universe.map(u => ({ symbol: u.symbol, sector: u.sector })),
    snapshots, priceMap: tickPriceMap, trigger: 'SESSION_OPEN', risk,
  });

  const prevSnap = await repos.agents.getPreviousSnapshot(agentId, tradeDate);
  const engine = createEngine({ repos, logger });
  const runner = createRunner({ repos, engine, provider, logger });

  const indicatorsMissingSymbols = new Set(
    context.universe.filter(u => u.indicatorsMissing).map(u => u.symbol));

  const run = await runner.runOnce({
    agentId,
    agentDef: { ...def, personaPrompt: def?.personaPrompt ?? '', riskConfig: risk },
    context,
    ctx: {
      tradeDate, refPriceMap, tickPriceMap,
      nav: context.portfolio.nav,
      dayPnl: prevSnap ? context.portfolio.nav - prevSnap.nav : 0,
      risk, indicatorsMissingSymbols,
    },
  });

  const close = await closeSession({ repos, agentId, tradeDate, priceMap: tickPriceMap });

  logger.info(
    `[session] ${agentId} ${tradeDate}: ${run.results.length} lệnh, ` +
    `NAV ${close.nav.toLocaleString('vi-VN')} (${close.totalReturnPct}%)`);

  return {
    status: run.status, agentId, tradeDate,
    decisions: run.decisions, invalid: run.invalid, results: run.results, close,
  };
}

async function buildPriceMaps(client, universe) {
  const symbols = universe.map(u => u.symbol);
  const refPriceMap = new Map();
  const tickPriceMap = new Map();
  if (symbols.length === 0) return { refPriceMap, tickPriceMap };

  // Giá tham chiếu = giá đóng cửa phiên gần nhất.
  const ref = await client.query(
    `SELECT DISTINCT ON (symbol) symbol, close FROM ohlcv_daily
     WHERE symbol = ANY($1) ORDER BY symbol, trade_date DESC`, [symbols]);
  for (const r of ref.rows) refPriceMap.set(r.symbol, toVnd(Number(r.close)));

  // Giá khớp = tick gần nhất; chưa có tick thì dùng giá tham chiếu.
  const tick = await client.query(
    `SELECT DISTINCT ON (symbol) symbol, price FROM quote_tick
     WHERE symbol = ANY($1) ORDER BY symbol, ts DESC`, [symbols]);
  for (const r of tick.rows) tickPriceMap.set(r.symbol, toVnd(Number(r.price)));
  for (const [s, p] of refPriceMap) if (!tickPriceMap.has(s)) tickPriceMap.set(s, p);

  return { refPriceMap, tickPriceMap };
}

async function buildIndicatorMap(client, universe) {
  const symbols = universe.map(u => u.symbol);
  const map = new Map();
  if (symbols.length === 0) return map;
  const { rows } = await client.query(
    `SELECT DISTINCT ON (symbol) symbol, payload FROM indicator_snapshot
     WHERE symbol = ANY($1) ORDER BY symbol, captured_at DESC`, [symbols]);
  for (const r of rows) {
    const { _raw, ...parsed } = r.payload ?? {};
    map.set(r.symbol, parsed);
  }
  return map;
}
