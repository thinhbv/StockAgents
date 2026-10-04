import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo } from '../src/repositories/agents.js';
import { createLlmUsageRepo } from '../src/repositories/llm_usage.js';

let client, agents, llmUsage;
const TABLES = ['llm_usage', 'agents'];

before(async () => {
  client = await withTestDb();
  agents = createAgentsRepo(client);
  llmUsage = createLlmUsageRepo(client);
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'anthropic', model: 'claude-haiku-4-5', personaPrompt: 'p', initialCapital: 1_000_000_000 },
    { id: 'a2', name: 'A2', provider: 'openai', model: 'gpt-5', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

test('insertUsage lưu đủ các trường, mặc định 0 cho token nếu không truyền', async () => {
  await llmUsage.insertUsage({ agentId: 'a1', provider: 'anthropic', model: 'claude-haiku-4-5', purpose: 'decision' });
  const { rows } = await client.query('SELECT * FROM llm_usage');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, 'a1');
  assert.equal(rows[0].input_tokens, 0);
  assert.equal(rows[0].succeeded, true);
});

test('insertUsage lưu đúng số token input/output/cache', async () => {
  await llmUsage.insertUsage({
    agentId: 'a1', provider: 'anthropic', model: 'claude-haiku-4-5', purpose: 'decision',
    inputTokens: 1500, outputTokens: 300, cacheReadTokens: 1200, cacheWriteTokens: 0,
  });
  const { rows } = await client.query('SELECT * FROM llm_usage');
  assert.equal(rows[0].input_tokens, 1500);
  assert.equal(rows[0].output_tokens, 300);
  assert.equal(rows[0].cache_read_tokens, 1200);
});

test('insertUsage ghi được lượt bỏ lượt (succeeded=false)', async () => {
  await llmUsage.insertUsage({
    agentId: 'a1', provider: 'anthropic', model: 'claude-haiku-4-5', purpose: 'decision', succeeded: false,
  });
  const { rows } = await client.query('SELECT succeeded FROM llm_usage');
  assert.equal(rows[0].succeeded, false);
});

test('insertUsage từ chối purpose lạ — hợp đồng cố định chỉ decision/reflect', async () => {
  await assert.rejects(() => llmUsage.insertUsage({
    agentId: 'a1', provider: 'anthropic', model: 'm', purpose: 'chitchat',
  }));
});

test('totalsByAgent gộp đúng theo agent, trong khoảng thời gian', async () => {
  await llmUsage.insertUsage({
    agentId: 'a1', provider: 'anthropic', model: 'm', purpose: 'decision',
    inputTokens: 1000, outputTokens: 100,
  });
  await llmUsage.insertUsage({
    agentId: 'a1', provider: 'anthropic', model: 'm', purpose: 'reflect',
    inputTokens: 2000, outputTokens: 200,
  });
  await llmUsage.insertUsage({
    agentId: 'a2', provider: 'openai', model: 'm', purpose: 'decision',
    inputTokens: 500, outputTokens: 50,
  });

  const totals = await llmUsage.totalsByAgent();
  const a1 = totals.find(t => t.agentId === 'a1');
  const a2 = totals.find(t => t.agentId === 'a2');
  assert.equal(a1.requests, 2);
  assert.equal(a1.inputTokens, 3000);
  assert.equal(a1.outputTokens, 300);
  assert.equal(a2.requests, 1);
  assert.equal(a2.inputTokens, 500);
});

test('totalsByAgent không tính các bản ghi ngoài khoảng sinceHours', async () => {
  await client.query(
    `INSERT INTO llm_usage (agent_id, provider, model, purpose, input_tokens, created_at)
     VALUES ('a1', 'anthropic', 'm', 'decision', 9999, now() - interval '10 days')`);
  await llmUsage.insertUsage({ agentId: 'a1', provider: 'anthropic', model: 'm', purpose: 'decision', inputTokens: 10 });

  const totals = await llmUsage.totalsByAgent({ sinceHours: 24 });
  const a1 = totals.find(t => t.agentId === 'a1');
  assert.equal(a1.requests, 1, 'bản ghi 10 ngày trước phải bị loại khỏi cửa sổ 24h');
  assert.equal(a1.inputTokens, 10);
});

test('totalsByAgent đếm riêng số lượt thất bại', async () => {
  await llmUsage.insertUsage({ agentId: 'a1', provider: 'anthropic', model: 'm', purpose: 'decision', succeeded: true });
  await llmUsage.insertUsage({ agentId: 'a1', provider: 'anthropic', model: 'm', purpose: 'decision', succeeded: false });

  const totals = await llmUsage.totalsByAgent();
  const a1 = totals.find(t => t.agentId === 'a1');
  assert.equal(a1.requests, 2);
  assert.equal(a1.failedRequests, 1);
});

test('recent trả về N bản ghi gần nhất, mới nhất trước', async () => {
  await llmUsage.insertUsage({ agentId: 'a1', provider: 'anthropic', model: 'm', purpose: 'decision', inputTokens: 1 });
  await llmUsage.insertUsage({ agentId: 'a1', provider: 'anthropic', model: 'm', purpose: 'decision', inputTokens: 2 });

  const rows = await llmUsage.recent({ limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].inputTokens, 2, 'bản ghi mới nhất phải đứng đầu');
});

test('recent lọc theo agentId khi truyền vào', async () => {
  await llmUsage.insertUsage({ agentId: 'a1', provider: 'anthropic', model: 'm', purpose: 'decision' });
  await llmUsage.insertUsage({ agentId: 'a2', provider: 'openai', model: 'm', purpose: 'decision' });

  const rows = await llmUsage.recent({ agentId: 'a1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, 'a1');
});
