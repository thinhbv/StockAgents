import {
  createAgentsRepo, createTradingRepo, createTriggersRepo,
  createEventsRepo, createOpsRepo, createUniverseRepo, createMarketRepo,
  createLessonsRepo, createNewsRepo,
} from '@stockagents/db';
import { toVnd } from '../sim/vn_rules.js';
import { createEngine } from '../sim/engine.js';
import { createRunner } from '../agents/runner.js';
import { createWatchdog } from './watchdog.js';
import { runSession } from '../session.js';
import { closeSession } from '../sim/pnl.js';
import { reflect } from '../learning/reflect.js';
import { recordOutcomes } from '../sim/outcomes.js';
import { computeAndSaveMetrics } from '../sim/metrics.js';
import { scoreLesson, outcomeHelped } from '../learning/scorer.js';
import { EVENTS } from './events.js';

export const SESSION_STATES = Object.freeze(
  ['PRE_OPEN', 'OPEN', 'WATCHING', 'CLOSING', 'LEARNING', 'IDLE']);

// Trạng thái dữ liệu cho phép mở phiên. DATA_STALE thì không —
// thà không giao dịch còn hơn giao dịch mù (spec §4).
const TRADEABLE_DATA_STATES = new Set(['DATA_READY', 'DATA_PARTIAL']);

export function createOrchestrator({ client, logger = console }) {
  const repos = {
    agents: createAgentsRepo(client),
    trading: createTradingRepo(client),
    triggers: createTriggersRepo(client),
    events: createEventsRepo(client),
    ops: createOpsRepo(client),
    universe: createUniverseRepo(client),
    market: createMarketRepo(client),
    lessons: createLessonsRepo(client),
    news: createNewsRepo(client),
  };

  async function emitState(state, agentId, extra = {}) {
    await repos.events.appendEvent({
      type: EVENTS.SESSION_STATE, agentId, payload: { state, ...extra },
    });
  }

  async function runDay({ agentId, agentDef, tradeDate, provider, ticks = [], embedder }) {
    // ---- PRE_OPEN: kiểm tra dữ liệu trước khi cho ai giao dịch ----
    const sessionState = await repos.ops.getSessionState(tradeDate);
    const dataState = sessionState?.state ?? 'DATA_STALE';
    await emitState('PRE_OPEN', agentId, { dataState });

    if (!TRADEABLE_DATA_STATES.has(dataState)) {
      logger.warn(`[orchestrator] ${agentId} ${tradeDate}: dữ liệu ${dataState}, không mở phiên`);
      return { state: 'PRE_OPEN', tradeDate, dataState, open: null, watch: [], close: null };
    }
    if (dataState === 'DATA_PARTIAL') {
      logger.warn(`[orchestrator] ${agentId} ${tradeDate}: dữ liệu chỉ đủ một phần`);
    }

    // ---- OPEN: agent quyết định mở vị thế ----
    await emitState('OPEN', agentId, { dataState });
    // Giá lúc mở phiên là tick ĐẦU TIÊN của ngày, không phải tick mới nhất.
    // Nếu để runSession tự lấy tick mới nhất, khi phát lại cả ngày agent sẽ
    // mua ở giá đóng cửa — và mọi trigger sau đó đều vô nghĩa.
    const openPrices = ticks.length > 0 ? mapToVnd(ticks[0].prices) : undefined;
    const open = await runSession({
      client, agentId, tradeDate, provider, agentDef, logger, priceOverride: openPrices,
    });

    // ---- WATCHING: vòng theo dõi, chỉ đánh thức LLM khi chạm ngưỡng ----
    await emitState('WATCHING', agentId, { tickCount: ticks.length });
    const engine = createEngine({ repos, logger });
    const runner = createRunner({ repos, engine, provider, logger });
    const watchdog = createWatchdog({ repos, engine, runner, logger });

    const universe = await repos.universe.listActive();
    const refPriceMap = await buildRefPriceMap(client, universe);
    const watch = [];

    // Tin xấu về mã đang giữ là một trong sáu điều kiện đánh thức. Lấy
    // sentiment TỆ NHẤT trong 24 giờ chứ không phải trung bình — một tin rất
    // xấu bị vài tin trung tính pha loãng thì sẽ không đánh thức được ai.
    const since = new Date(Date.now() - 24 * 3600_000);
    const newsSentimentMap = await repos.news.worstSentimentBySymbol({ since });

    for (const tick of ticks) {
      watch.push(await watchdog.tick({
        agentId, agentDef, now: tick.at, tradeDate,
        tickPriceMap: mapToVnd(tick.prices), refPriceMap,
        newsSentimentMap: tick.newsSentiment ?? newsSentimentMap,
      }));
    }

    // ---- CLOSING: mark-to-market bằng giá cuối cùng thấy được ----
    await emitState('CLOSING', agentId);
    const finalPrices = ticks.length > 0
      ? mapToVnd(ticks[ticks.length - 1].prices)
      : await buildTickPriceMap(client, universe);
    const close = await closeSession({ repos, agentId, tradeDate, priceMap: finalPrices });

    // ---- LEARNING ----
    await emitState('LEARNING', agentId);

    // Thứ tự ở đây là quan hệ phụ thuộc, không phải tuỳ tiện:
    // 1. Ghép mua-bán thành vòng trọn vẹn -> mới biết lệnh nào lãi
    // 2. Chấm điểm bài học theo kết quả vòng đó
    // 3. Tính metric từ các vòng đã ghi
    // 4. Rút bài học mới (dùng chính các vòng vừa ghi làm bằng chứng)
    const outcomes = await recordOutcomes({ repos, agentId, logger });

    for (const round of outcomes.rounds) {
      await repos.lessons.applyOutcome(
        agentId, round.entryTradeId, outcomeHelped(round.pnl), scoreLesson);
    }

    const metrics = await computeAndSaveMetrics({ repos, agentId, tradeDate });
    await repos.events.appendEvent({
      type: EVENTS.METRICS_UPDATED, agentId,
      payload: { ...metrics, nav: close.nav, dayPnl: close.dayPnl },
    });

    const learned = await reflect({
      repos, agentId, agentDef, provider, tradeDate, embedder, logger,
    });

    await emitState('IDLE', agentId);
    return { state: 'IDLE', tradeDate, dataState, open, watch, close, learned, outcomes, metrics };
  }

  return { runDay };
}

function mapToVnd(prices) {
  const out = new Map();
  for (const [symbol, tvPrice] of prices) out.set(symbol, toVnd(tvPrice));
  return out;
}

async function buildRefPriceMap(client, universe) {
  const symbols = universe.map(u => u.symbol);
  const map = new Map();
  if (symbols.length === 0) return map;
  const { rows } = await client.query(
    `SELECT DISTINCT ON (symbol) symbol, close FROM ohlcv_daily
     WHERE symbol = ANY($1) ORDER BY symbol, trade_date DESC`, [symbols]);
  for (const r of rows) map.set(r.symbol, toVnd(Number(r.close)));
  return map;
}

async function buildTickPriceMap(client, universe) {
  const symbols = universe.map(u => u.symbol);
  const map = new Map();
  if (symbols.length === 0) return map;
  const { rows } = await client.query(
    `SELECT DISTINCT ON (symbol) symbol, price FROM quote_tick
     WHERE symbol = ANY($1) ORDER BY symbol, ts DESC`, [symbols]);
  for (const r of rows) map.set(r.symbol, toVnd(Number(r.price)));
  return map;
}
