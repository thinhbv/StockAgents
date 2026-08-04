import { scoreLesson, shouldRetire, outcomeHelped, RETIRE_BELOW, MIN_RETRIEVALS_BEFORE_RETIRE } from './scorer.js';

const LESSON_SCHEMA = {
  type: 'object',
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lesson: { type: 'string' },
          confidence: { type: 'number' },
          evidenceTradeIds: { type: 'array', items: { type: 'integer' } },
        },
        required: ['lesson'],
      },
    },
  },
  required: ['lessons'],
};

/**
 * Vòng học cuối phiên (spec §8.3).
 *
 * Bài học do CHÍNH model của agent đó sinh ra, không phải model khác — nếu
 * dùng chung một model để rút kinh nghiệm cho cả năm agent thì năm agent sẽ
 * dần hội tụ về cùng một lối nghĩ, và việc so sánh mất ý nghĩa.
 */
export async function reflect({ repos, agentId, agentDef, provider, tradeDate, embedder, logger = console }) {
  const trades = await repos.trading.listTrades(agentId, 50);
  if (trades.length === 0) return { status: 'NO_TRADES', created: 0, retired: 0 };

  const summary = trades.map(t => ({
    id: t.id, symbol: t.symbol, action: t.action,
    priceVnd: t.priceVnd, qty: t.qty, reason: t.reason, confidence: t.confidence,
  }));

  let raw;
  try {
    raw = await provider.complete({
      system: `${agentDef.personaPrompt}\n\nBạn đang nhìn lại các lệnh đã thực hiện để rút ra bài học cho lần sau. Bài học phải cụ thể và kiểm chứng được, không phải lời khuyên chung chung. Nêu rõ lệnh nào dẫn tới bài học đó.`,
      messages: [{ role: 'user', content: JSON.stringify({ tradeDate, trades: summary }) }],
      jsonSchema: LESSON_SCHEMA,
    });
  } catch (err) {
    logger.warn(`[reflect] ${agentId} bỏ vòng học: ${err.message}`);
    return { status: 'SKIPPED', error: err.message, created: 0, retired: 0 };
  }

  const list = Array.isArray(raw) ? raw : (raw?.lessons ?? []);
  let created = 0;

  for (const item of list) {
    if (typeof item?.lesson !== 'string' || item.lesson.trim() === '') continue;
    const text = item.lesson.trim();
    const embedding = embedder ? await embedder(text) : null;
    await repos.lessons.insert(agentId, {
      lesson: text,
      confidence: Number.isFinite(item.confidence) ? Math.min(1, Math.max(0, item.confidence)) : 0.5,
      evidenceTradeIds: Array.isArray(item.evidenceTradeIds) ? item.evidenceTradeIds : [],
      embedding,
    });
    created++;
  }

  const retired = await repos.lessons.pruneWeak(agentId, {
    below: RETIRE_BELOW, minRetrievals: MIN_RETRIEVALS_BEFORE_RETIRE,
  });

  logger.info(`[reflect] ${agentId}: +${created} bài học, loại ${retired}`);
  return { status: 'OK', created, retired };
}

export { scoreLesson, shouldRetire, outcomeHelped };
