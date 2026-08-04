import { parseArgs } from 'node:util';
import { createClient, loadConfig, createAgentsRepo } from '@stockagents/db';
import { loadAgentDefs } from './agents/registry.js';
import { createProvider } from './llm/provider.js';
import { runSession } from './session.js';

const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    date: { type: 'string' },
    stub: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (!values.agent || !values.date) {
  console.error('Dùng: npm run sim:session -- --agent <id> --date YYYY-MM-DD [--stub]');
  process.exit(1);
}

const cfg = loadConfig();
const client = createClient(cfg.databaseUrl);

try {
  const defs = await loadAgentDefs();
  const def = defs.find(d => d.id === values.agent);
  if (!def) {
    console.error(`Không tìm thấy agent '${values.agent}' trong config/agents.json.`);
    console.error(`Có sẵn: ${defs.map(d => d.id).join(', ')}`);
    process.exit(1);
  }

  // Đảm bảo agent tồn tại trong DB với vốn ban đầu.
  await createAgentsRepo(client).upsertMany([def]);

  const provider = createProvider({
    provider: values.stub ? 'stub' : def.provider,
    model: def.model,
  });

  const result = await runSession({
    client, agentId: def.id, tradeDate: values.date, provider, agentDef: def,
  });

  console.log(JSON.stringify({
    status: result.status,
    decisions: result.decisions.length,
    invalid: result.invalid?.length ?? 0,
    filled: result.results.filter(r => r.status === 'FILLED').length,
    rejected: result.results.filter(r => r.status === 'REJECTED').map(r => r.reason),
    close: result.close,
  }, null, 2));
} catch (err) {
  console.error(err.stack || err.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
