import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo } from '../src/repositories/agents.js';
import { createTriggersRepo } from '../src/repositories/triggers.js';

let client, agents, triggers;
const TABLES = ['trigger_log', 'portfolio_snapshot', 'agents', 'universe'];

before(async () => {
  client = await withTestDb();
  agents = createAgentsRepo(client);
  triggers = createTriggersRepo(client);
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1000000000 },
    { id: 'a2', name: 'A2', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1000000000 },
  ]);
});
after(async () => { await client.close(); });

test('hàm agent-scoped từ chối khi thiếu agentId', async () => {
  await assert.rejects(() => triggers.getLastFired(null, 'HOSE:FPT', 'STOP_LOSS'), /agentId/);
  await assert.rejects(() => triggers.recordFired('', 'HOSE:FPT', 'STOP_LOSS', new Date()), /agentId/);
});

test('chưa từng nổ thì trả null', async () => {
  assert.equal(await triggers.getLastFired('a1', 'HOSE:FPT', 'STOP_LOSS'), null);
});

test('recordFired lưu và đọc lại đúng thời điểm', async () => {
  const at = new Date('2026-07-20T10:00:00Z');
  await triggers.recordFired('a1', 'HOSE:FPT', 'STOP_LOSS', at);
  const got = await triggers.getLastFired('a1', 'HOSE:FPT', 'STOP_LOSS');
  assert.equal(got.getTime(), at.getTime());
});

test('nổ lại cùng loại thì ghi đè thời điểm, không tạo hàng mới', async () => {
  await triggers.recordFired('a1', 'HOSE:FPT', 'STOP_LOSS', new Date('2026-07-20T10:00:00Z'));
  await triggers.recordFired('a1', 'HOSE:FPT', 'STOP_LOSS', new Date('2026-07-20T11:00:00Z'));

  const { rows } = await client.query(`SELECT count(*)::int n FROM trigger_log WHERE agent_id='a1'`);
  assert.equal(rows[0].n, 1);
  const got = await triggers.getLastFired('a1', 'HOSE:FPT', 'STOP_LOSS');
  assert.equal(got.toISOString(), '2026-07-20T11:00:00.000Z');
});

test('các loại trigger khác nhau đếm nhịp riêng', async () => {
  await triggers.recordFired('a1', 'HOSE:FPT', 'STOP_LOSS', new Date('2026-07-20T10:00:00Z'));
  assert.equal(await triggers.getLastFired('a1', 'HOSE:FPT', 'TAKE_PROFIT'), null);
});

test('agent này không thấy nhịp chống rung của agent kia', async () => {
  await triggers.recordFired('a2', 'HOSE:FPT', 'STOP_LOSS', new Date('2026-07-20T10:00:00Z'));
  assert.equal(await triggers.getLastFired('a1', 'HOSE:FPT', 'STOP_LOSS'), null);
});

test('listRecent trả về theo thứ tự mới nhất trước, chỉ của agent đó', async () => {
  await triggers.recordFired('a1', 'HOSE:FPT', 'STOP_LOSS', new Date('2026-07-20T10:00:00Z'));
  await triggers.recordFired('a1', 'HOSE:FPT', 'TAKE_PROFIT', new Date('2026-07-20T11:00:00Z'));
  await triggers.recordFired('a2', 'HOSE:FPT', 'TIME_STOP', new Date('2026-07-20T12:00:00Z'));

  const list = await triggers.listRecent('a1', 10);
  assert.deepEqual(list.map(x => x.type), ['TAKE_PROFIT', 'STOP_LOSS']);
});
