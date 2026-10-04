import {
  createAgentsRepo, createTradingRepo, createTriggersRepo,
  createEventsRepo, createOpsRepo, createUniverseRepo, createMarketRepo,
  createLessonsRepo, createNewsRepo, createLlmUsageRepo,
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
    llmUsage: createLlmUsageRepo(client),
  };

  // `tradeDate` là ngày MÔ PHỎNG, không phải ngày thật lúc ghi event — phát
  // lại một tradeDate cũ (test, hoặc chạy bù) vẫn ghi `ts` là giờ THẬT lúc
  // chạy. Nên khoanh vùng "hôm nay đã mở/đã chốt chưa" phải dựa vào tradeDate
  // NẰM TRONG payload, không được suy ra từ `ts` — nếu không, watcher chạy
  // bù một `tradeDate` khác ngày thật sẽ luôn tưởng là chưa mở, mở lại vô hạn.
  async function emitState(state, agentId, tradeDate, extra = {}) {
    await repos.events.appendEvent({
      type: EVENTS.SESSION_STATE, agentId, payload: { state, tradeDate, ...extra },
    });
  }

  /**
   * Đã phát sự kiện OPEN cho agent này trong ngày `tradeDate` chưa.
   *
   * Dùng để watcher sống (chạy lại mỗi 5 phút, xem cli_watch.js) biết có cần
   * mở phiên hay chỉ cần theo dõi tiếp — gọi lại openDay() nhiều lần trong
   * ngày sẽ mua lại/mua thêm ngoài ý muốn vì runSession() không tự kiểm tra.
   */
  async function hasOpenedToday(agentId, tradeDate) {
    const { rows } = await client.query(
      `SELECT 1 FROM event_log
       WHERE agent_id = $1 AND type = $2
         AND payload->>'state' = 'OPEN' AND payload->>'tradeDate' = $3
       LIMIT 1`,
      [agentId, EVENTS.SESSION_STATE, tradeDate],
    );
    return rows.length > 0;
  }

  /** Cùng logic với hasOpenedToday, nhưng canh mốc IDLE (đã chốt sổ xong). */
  async function hasClosedToday(agentId, tradeDate) {
    const { rows } = await client.query(
      `SELECT 1 FROM event_log
       WHERE agent_id = $1 AND type = $2
         AND payload->>'state' = 'IDLE' AND payload->>'tradeDate' = $3
       LIMIT 1`,
      [agentId, EVENTS.SESSION_STATE, tradeDate],
    );
    return rows.length > 0;
  }

  /** ---- PRE_OPEN + OPEN: agent quyết định mở vị thế ---- */
  async function openDay({ agentId, agentDef, tradeDate, provider, priceOverride }) {
    const sessionState = await repos.ops.getSessionState(tradeDate);
    const dataState = sessionState?.state ?? 'DATA_STALE';
    await emitState('PRE_OPEN', agentId, tradeDate, { dataState });

    // Cùng bối cảnh vĩ mô mà buildContext bơm vào prompt agent (chỉ số VN
    // dùng chung) — đẩy luôn lên dashboard để người vận hành thấy như agent.
    const indices = await repos.market.getLatestIndices();
    if (indices.length > 0) {
      await repos.events.appendEvent({
        type: EVENTS.MARKET_SNAPSHOT, agentId, payload: { indices },
      });
    }

    if (!TRADEABLE_DATA_STATES.has(dataState)) {
      logger.warn(`[orchestrator] ${agentId} ${tradeDate}: dữ liệu ${dataState}, không mở phiên`);
      return { dataState, open: null, opened: false };
    }
    if (dataState === 'DATA_PARTIAL') {
      logger.warn(`[orchestrator] ${agentId} ${tradeDate}: dữ liệu chỉ đủ một phần`);
    }

    await emitState('OPEN', agentId, tradeDate, { dataState });
    const open = await runSession({
      client, agentId, tradeDate, provider, agentDef, logger, priceOverride,
    });
    return { dataState, open, opened: true };
  }

  /** Dựng engine/runner/watchdog dùng chung cho một ngày — tốn 1 query universe. */
  async function buildWatchContext(provider) {
    const engine = createEngine({ repos, logger });
    const runner = createRunner({ repos, engine, provider, logger });
    const watchdog = createWatchdog({ repos, engine, runner, logger });
    const universe = await repos.universe.listActive();
    const refPriceMap = await buildRefPriceMap(client, universe);
    return { engine, runner, watchdog, universe, refPriceMap };
  }

  /**
   * Tin xấu về mã đang giữ là một trong sáu điều kiện đánh thức. Lấy
   * sentiment TỆ NHẤT trong 24 giờ chứ không phải trung bình — một tin rất
   * xấu bị vài tin trung tính pha loãng thì sẽ không đánh thức được ai.
   */
  async function latestNewsSentimentMap() {
    const since = new Date(Date.now() - 24 * 3600_000);
    return repos.news.worstSentimentBySymbol({ since });
  }

  /** ---- CLOSING + LEARNING: mark-to-market, ghép vòng, rút bài học ---- */
  async function closeDay({ agentId, agentDef, tradeDate, provider, priceMap, embedder }) {
    await emitState('CLOSING', agentId, tradeDate);
    const close = await closeSession({ repos, agentId, tradeDate, priceMap });

    await emitState('LEARNING', agentId, tradeDate);

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

    await emitState('IDLE', agentId, tradeDate);
    return { close, outcomes, metrics, learned };
  }

  async function runDay({ agentId, agentDef, tradeDate, provider, ticks = [], embedder }) {
    // Giá lúc mở phiên là tick ĐẦU TIÊN của ngày, không phải tick mới nhất.
    // Nếu để runSession tự lấy tick mới nhất, khi phát lại cả ngày agent sẽ
    // mua ở giá đóng cửa — và mọi trigger sau đó đều vô nghĩa.
    const openPrices = ticks.length > 0 ? mapToVnd(ticks[0].prices) : undefined;
    const { dataState, open, opened } = await openDay({
      agentId, agentDef, tradeDate, provider, priceOverride: openPrices,
    });
    if (!opened) {
      return { state: 'PRE_OPEN', tradeDate, dataState, open: null, watch: [], close: null };
    }

    // ---- WATCHING: vòng theo dõi, chỉ đánh thức LLM khi chạm ngưỡng ----
    await emitState('WATCHING', agentId, tradeDate, { tickCount: ticks.length });
    const { watchdog, universe, refPriceMap } = await buildWatchContext(provider);
    const newsSentimentMap = await latestNewsSentimentMap();
    const watch = [];

    for (const tick of ticks) {
      watch.push(await watchdog.tick({
        agentId, agentDef, now: tick.at, tradeDate,
        tickPriceMap: mapToVnd(tick.prices), refPriceMap, universe,
        newsSentimentMap: tick.newsSentiment ?? newsSentimentMap,
      }));
    }

    const finalPrices = ticks.length > 0
      ? mapToVnd(ticks[ticks.length - 1].prices)
      : await buildTickPriceMap(client, universe);
    const { close, outcomes, metrics, learned } = await closeDay({
      agentId, agentDef, tradeDate, provider, priceMap: finalPrices, embedder,
    });

    return { state: 'IDLE', tradeDate, dataState, open, watch, close, learned, outcomes, metrics };
  }

  /** Giá TICK MỚI NHẤT hiện có — dùng để mark-to-market lúc chốt sổ hoặc để watchdog tick sống. */
  async function latestTickPriceMap(universe) {
    return buildTickPriceMap(client, universe);
  }

  /**
   * Giá tick ĐẦU TIÊN của `tradeDate` — giá mở phiên đúng nghĩa, không phải
   * tick mới nhất. Watcher sống (cli_watch.js) cần cái này khi mở phiên
   * muộn hơn 09:00 (ví dụ agent chưa mở lúc 09:05 vì lỗi tạm thời, mở bù lúc
   * 09:10) vẫn phải mua ở giá LÚC MỞ CỬA, không phải giá lúc nó mới chạy.
   */
  async function firstTickPriceMap(universe, tradeDate) {
    const symbols = universe.map(u => u.symbol);
    const map = new Map();
    if (symbols.length === 0) return map;
    // Một câu query DUY NHẤT (DISTINCT ON), không tách thành MIN(ts) rồi so
    // khớp lại `ts = $2` — cột ts lưu tới micro-giây nhưng JS Date chỉ giữ
    // mili-giây, giá trị mang ra rồi đưa lại làm tham số sẽ mất phần đuôi
    // (vd .661770 -> .661) nên `ts = $2` không bao giờ khớp, luôn trả 0 dòng.
    const { rows } = await client.query(
      `SELECT DISTINCT ON (symbol) symbol, price FROM quote_tick
       WHERE symbol = ANY($1) AND ts AT TIME ZONE 'Asia/Ho_Chi_Minh' >= $2::date
         AND ts AT TIME ZONE 'Asia/Ho_Chi_Minh' < ($2::date + 1)
       ORDER BY symbol, ts ASC`,
      [symbols, tradeDate],
    );
    for (const r of rows) map.set(r.symbol, toVnd(Number(r.price)));
    return map;
  }

  return {
    runDay, openDay, closeDay, buildWatchContext, latestNewsSentimentMap,
    hasOpenedToday, hasClosedToday, latestTickPriceMap, firstTickPriceMap,
  };
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
