import { parseArgs } from 'node:util';
import { createClient, loadConfig, createAgentsRepo } from '@stockagents/db';
import { loadAgentDefs } from './agents/registry.js';
import { createProvider, availableProviders } from './llm/provider.js';
import { createOrchestrator } from './orchestrator/session.js';

const { values } = parseArgs({
  options: {
    date: { type: 'string' },
    stub: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (!values.date) {
  console.error('Dùng: npm run sim:all -- --date YYYY-MM-DD [--stub]');
  process.exit(1);
}

const cfg = loadConfig();
const client = createClient(cfg.databaseUrl);

try {
  const defs = await loadAgentDefs();
  await createAgentsRepo(client).upsertMany(defs);

  const have = availableProviders();
  if (!values.stub) {
    const missing = [...new Set(defs.map(d => d.provider))].filter(p => !have.includes(p));
    if (missing.length > 0) {
      console.error(
        `Thiếu API key cho: ${missing.join(', ')}.\n` +
        `Điền vào .env, hoặc chạy với --stub để mô phỏng không cần key.`);
      process.exit(1);
    }
  }

  // Phát lại tick của ngày, dùng CHUNG cho mọi agent — đó là điều kiện để
  // so sánh công bằng: cùng dữ liệu, cùng thời điểm, chỉ khác model và chiến lược.
  const { rows } = await client.query(
    `SELECT symbol, price, ts FROM quote_tick
     WHERE ts AT TIME ZONE 'Asia/Ho_Chi_Minh' >= $1::date
       AND ts AT TIME ZONE 'Asia/Ho_Chi_Minh' < ($1::date + 1)
     ORDER BY ts`, [values.date]);

  const byTs = new Map();
  for (const r of rows) {
    const k = r.ts.toISOString();
    if (!byTs.has(k)) byTs.set(k, { at: r.ts, prices: new Map() });
    byTs.get(k).prices.set(r.symbol, Number(r.price));
  }
  const ticks = [...byTs.values()];

  const orch = createOrchestrator({ client });
  const results = [];

  // Tuần tự chứ không song song: các agent dùng chung một connection pool, và
  // chạy lần lượt giúp log đọc được. Không agent nào thấy dữ liệu của agent khác.
  for (const def of defs) {
    const provider = createProvider({
      provider: values.stub ? 'stub' : def.provider, model: def.model,
    });
    const r = await orch.runDay({
      agentId: def.id, agentDef: def, tradeDate: values.date, provider, ticks,
    });
    results.push({
      agent: def.id,
      model: values.stub ? 'stub' : `${def.provider}/${def.model}`,
      state: r.state,
      filled: r.open?.results.filter(x => x.status === 'FILLED').length ?? 0,
      rejected: r.open?.results.filter(x => x.status === 'REJECTED').length ?? 0,
      llmWakeups: r.watch.reduce((s, w) => s + w.woken, 0),
      nav: r.close?.nav ?? null,
      totalReturnPct: r.close?.totalReturnPct ?? null,
    });
  }

  results.sort((a, b) => (b.nav ?? -Infinity) - (a.nav ?? -Infinity));

  console.log(`\nPhiên ${values.date} · ${ticks.length} nhịp tick · ${defs.length} agent\n`);
  console.log('  #  AGENT               MODEL                      NAV            LÃI/LỖ  LỆNH  ĐÁNH THỨC');
  for (const [i, r] of results.entries()) {
    console.log(
      `  ${String(i + 1).padStart(2)}  ${r.agent.padEnd(20)}${r.model.padEnd(24)}` +
      `${(r.nav === null ? '—' : r.nav.toLocaleString('vi-VN')).padStart(16)}` +
      `${(r.totalReturnPct === null ? '—' : `${r.totalReturnPct}%`).padStart(10)}` +
      `${String(r.filled).padStart(6)}${String(r.llmWakeups).padStart(11)}`);
  }
  console.log('');
} catch (err) {
  console.error(err.stack || err.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
