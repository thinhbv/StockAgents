import { parseArgs } from 'node:util';
import { createClient, loadConfig, createAgentsRepo } from '@stockagents/db';
import { loadAgentDefs } from './agents/registry.js';
import { createProvider } from './llm/provider.js';
import { createOrchestrator } from './orchestrator/session.js';

const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    date: { type: 'string' },
    stub: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (!values.agent || !values.date) {
  console.error('Dùng: npm run sim:day -- --agent <id> --date YYYY-MM-DD [--stub]');
  process.exit(1);
}

const cfg = loadConfig();
const client = createClient(cfg.databaseUrl);

try {
  const defs = await loadAgentDefs();
  const def = defs.find(d => d.id === values.agent);
  if (!def) {
    console.error(`Không tìm thấy agent '${values.agent}'. Có sẵn: ${defs.map(d => d.id).join(', ')}`);
    process.exit(1);
  }

  await createAgentsRepo(client).upsertMany([def]);

  const provider = createProvider({
    provider: values.stub ? 'stub' : def.provider, model: def.model,
  });

  // Phát lại các tick đã thu trong ngày. Watchdog chỉ đánh thức LLM khi
  // chạm ngưỡng, nên số tick nhiều không đồng nghĩa tốn nhiều token.
  const { rows } = await client.query(
    `SELECT symbol, price, ts FROM quote_tick
     WHERE ts AT TIME ZONE 'Asia/Ho_Chi_Minh' >= $1::date
       AND ts AT TIME ZONE 'Asia/Ho_Chi_Minh' < ($1::date + 1)
     ORDER BY ts`, [values.date]);

  const byTs = new Map();
  for (const r of rows) {
    const key = r.ts.toISOString();
    if (!byTs.has(key)) byTs.set(key, { at: r.ts, prices: new Map() });
    byTs.get(key).prices.set(r.symbol, Number(r.price));
  }
  const ticks = [...byTs.values()];

  const orch = createOrchestrator({ client });
  const r = await orch.runDay({
    agentId: def.id, agentDef: def, tradeDate: values.date, provider, ticks,
  });

  console.log(JSON.stringify({
    state: r.state,
    dataState: r.dataState,
    tickCount: ticks.length,
    openFilled: r.open?.results.filter(x => x.status === 'FILLED').length ?? 0,
    triggersFired: r.watch.flatMap(w => w.fired).map(t => `${t.type} ${t.symbol}`),
    llmWakeups: r.watch.reduce((s, w) => s + w.woken, 0),
    close: r.close,
  }, null, 2));
} catch (err) {
  console.error(err.stack || err.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
