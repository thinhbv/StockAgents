import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { loadConfig } from '../src/config.js';
import { createEventsRepo } from '../src/repositories/events.js';
import { assertAgentScope } from '../src/repositories/_guard.js';

let client, repo;

before(async () => {
  client = await withTestDb();
  repo = createEventsRepo(client);
});
beforeEach(async () => { await resetTables(client, ['event_log']); });
after(async () => { await client.close(); });

test('assertAgentScope trả về id khi hợp lệ', () => {
  assert.equal(assertAgentScope(' claude_value ', 'getLessons'), 'claude_value');
});

test('assertAgentScope ném lỗi nêu tên hàm khi thiếu agentId', () => {
  assert.throws(() => assertAgentScope(undefined, 'getLessons'), /getLessons.*agentId/s);
  assert.throws(() => assertAgentScope('', 'getLessons'), /agentId/);
  assert.throws(() => assertAgentScope(123, 'getLessons'), /agentId/);
});

test('appendEvent lưu sự kiện và trả về id tăng dần', async () => {
  const a = await repo.appendEvent({ type: 'data.ingested', payload: { job: 'prices' } });
  const b = await repo.appendEvent({ type: 'session.state', payload: { state: 'OPEN' } });
  assert.ok(b.id > a.id);
  assert.ok(a.ts instanceof Date);
});

test('appendEvent phát NOTIFY trên kênh agent_events với phong bì gọn', async () => {
  const cfg = loadConfig();
  const listener = new pg.Client({ connectionString: cfg.databaseUrlTest });
  await listener.connect();
  await listener.query('LISTEN agent_events');

  const received = new Promise((resolve) => {
    listener.on('notification', (msg) => resolve(JSON.parse(msg.payload)));
  });

  try {
    const { id } = await repo.appendEvent({
      type: 'agent.decided',
      agentId: null,
      payload: { decisions: [] },
    });

    const envelope = await received;
    assert.equal(envelope.id, id);
    assert.equal(envelope.type, 'agent.decided');
    assert.equal(envelope.agentId, null);
    // Phong bì phải nhỏ hơn nhiều so với giới hạn 8000 byte của NOTIFY
    assert.ok(JSON.stringify(envelope).length < 200);
  } finally {
    await listener.end();
  }
});

test('getEventsSince trả về sự kiện có id lớn hơn con trỏ, theo thứ tự tăng', async () => {
  const first = await repo.appendEvent({ type: 'e1', payload: {} });
  await repo.appendEvent({ type: 'e2', payload: {} });
  await repo.appendEvent({ type: 'e3', payload: {} });

  const rows = await repo.getEventsSince(first.id, 10);
  assert.deepEqual(rows.map(r => r.type), ['e2', 'e3']);
  assert.deepEqual(rows[0].payload, {});
});

test('getEventsSince tôn trọng limit', async () => {
  for (let i = 0; i < 5; i++) await repo.appendEvent({ type: `e${i}`, payload: {} });
  const rows = await repo.getEventsSince(0, 2);
  assert.equal(rows.length, 2);
});

test('pruneOlderThan xóa sự kiện cũ và giữ sự kiện mới', async () => {
  await client.query(
    `INSERT INTO event_log (ts, type, payload) VALUES (now() - interval '100 days', 'old', '{}')`);
  await repo.appendEvent({ type: 'new', payload: {} });

  const deleted = await repo.pruneOlderThan(90);
  assert.equal(deleted, 1);

  const { rows } = await client.query('SELECT type FROM event_log');
  assert.deepEqual(rows.map(r => r.type), ['new']);
});

test('pruneOlderThan từ chối số ngày không dương và không xóa gì', async () => {
  await client.query(
    `INSERT INTO event_log (ts, type, payload) VALUES (now() - interval '100 days', 'old', '{}')`);

  await assert.rejects(() => repo.pruneOlderThan(-10), /pruneOlderThan.*-10/s);

  const { rows } = await client.query('SELECT type FROM event_log');
  assert.deepEqual(rows.map(r => r.type), ['old']);
});
