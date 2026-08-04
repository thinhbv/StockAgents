import { validateDecision } from '../llm/decision_schema.js';

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'] },
          symbol: { type: 'string' },
          quantity: { type: 'integer' },
          orderType: { type: 'string', enum: ['MARKET', 'LIMIT', 'ATC'] },
          limitPriceVnd: { type: 'number' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
          exitPlan: {
            type: 'object',
            properties: {
              takeProfitPct: { type: 'number' },
              stopLossPct: { type: 'number' },
              timeStopDays: { type: 'integer' },
              trailingPct: { type: 'number' },
            },
          },
        },
        required: ['action', 'symbol', 'reason'],
      },
    },
  },
  required: ['decisions'],
};

export function createRunner({ repos, engine, provider, logger = console }) {

  async function runOnce({ agentId, agentDef, context, ctx }) {
    let raw;
    try {
      raw = await provider.complete({
        system: agentDef.personaPrompt,
        messages: [{ role: 'user', content: JSON.stringify(context) }],
        jsonSchema: DECISION_SCHEMA,
      });
    } catch (err) {
      // Provider chết thì agent BỎ LƯỢT — không fallback sang model khác,
      // vì như vậy sẽ làm hỏng việc so sánh giữa các agent (spec §6.5).
      logger.warn(`[runner] ${agentId} bỏ lượt: ${err.message}`);
      return { status: 'SKIPPED', error: err.message, decisions: [], invalid: [], results: [] };
    }

    const list = Array.isArray(raw) ? raw : [raw];
    const decisions = [];
    const invalid = [];

    for (const item of list) {
      const v = validateDecision(item);
      if (v.ok) decisions.push(v.value);
      else {
        invalid.push({ raw: item, errors: v.errors });
        logger.warn(`[runner] ${agentId} quyết định sai schema: ${v.errors.join('; ')}`);
      }
    }

    const results = [];
    for (const d of decisions) {
      results.push(await engine.submit(agentId, d, {
        ...ctx, risk: agentDef.riskConfig ?? ctx.risk,
      }));
    }

    return { status: 'OK', decisions, invalid, results };
  }

  return { runOnce };
}
