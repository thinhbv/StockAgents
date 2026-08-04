import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';

let client;
before(async () => {
  client = await withTestDb();
  // Self-contained cleanup: don't rely on another test file (e.g. migrate.test.js's
  // DROP SCHEMA) having wiped the database first. Reset exactly the tables this
  // file's fixtures write to, in FK-safe order (CASCADE handles the rest).
  await resetTables(client, ['news_items', 'lessons', 'metrics_daily', 'trades', 'fills', 'orders', 'positions', 'ohlcv_daily', 'event_log', 'agents', 'universe']);
});
after(async () => { await client.close(); });

const EXPECTED_TABLES = [
  'universe', 'ohlcv_daily', 'indicator_snapshot', 'quote_tick',
  'market_index_snapshot', 'session_state', 'ingest_errors',
  'agents', 'orders', 'fills', 'positions', 'position_lots',
  'trades', 'trade_outcomes', 'portfolio_snapshot', 'metrics_daily',
  'news_items', 'lessons', 'lesson_usage', 'event_log',
];

test('mọi bảng theo spec đều tồn tại', async () => {
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  const actual = new Set(rows.map(r => r.tablename));
  const missing = EXPECTED_TABLES.filter(t => !actual.has(t));
  assert.deepEqual(missing, [], `thiếu bảng: ${missing.join(', ')}`);
});

test('ohlcv_daily chặn trùng (symbol, trade_date)', async () => {
  await client.query(`INSERT INTO universe (symbol, exchange, name)
                      VALUES ('HOSE:FPT', 'HOSE', 'FPT Corp')
                      ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
                      VALUES ('HOSE:FPT', '2026-07-20', 100, 110, 99, 108, 1000)`);
  await assert.rejects(
    client.query(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
                  VALUES ('HOSE:FPT', '2026-07-20', 1, 1, 1, 1, 1)`),
    /duplicate key/,
  );
});

test('mọi bảng thuộc về agent đều có agent_id NOT NULL', async () => {
  // fills nằm trong danh sách này: nếu nó chỉ tới được qua orders.agent_id thì
  // assertAgentScope() không bảo vệ nổi, và cô lập agent quay về dựa vào quy ước.
  const agentTables = ['orders', 'fills', 'positions', 'trades', 'lessons',
                       'portfolio_snapshot', 'metrics_daily'];
  const { rows } = await client.query(`
    SELECT table_name, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'agent_id'
      AND table_name = ANY($1)`, [agentTables]);
  assert.equal(rows.length, agentTables.length, 'có bảng thiếu cột agent_id');
  const nullable = rows.filter(r => r.is_nullable === 'YES').map(r => r.table_name);
  assert.deepEqual(nullable, [], `agent_id cho phép NULL ở: ${nullable.join(', ')}`);
});

test('positions chặn hai vị thế mở cùng mã cho cùng agent', async () => {
  await client.query(`INSERT INTO agents (id, name, provider, model, persona_prompt, initial_capital)
                      VALUES ('t1', 'Test', 'anthropic', 'claude-opus-5', 'p', 1000000000)
                      ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO positions (agent_id, symbol, qty_total, qty_sellable, avg_cost)
                      VALUES ('t1', 'HOSE:FPT', 100, 0, 100)`);
  await assert.rejects(
    client.query(`INSERT INTO positions (agent_id, symbol, qty_total, qty_sellable, avg_cost)
                  VALUES ('t1', 'HOSE:FPT', 200, 0, 100)`),
    /duplicate key/,
  );
});

test('event_log có id tăng dần dùng làm con trỏ SSE', async () => {
  const a = await client.query(
    `INSERT INTO event_log (type, payload) VALUES ('a', '{}') RETURNING id`);
  const b = await client.query(
    `INSERT INTO event_log (type, payload) VALUES ('b', '{}') RETURNING id`);
  assert.ok(b.rows[0].id > a.rows[0].id);
});

test('trades.confidence bị giới hạn trong khoảng 0..1', async () => {
  await client.query(`INSERT INTO agents (id, name, provider, model, persona_prompt, initial_capital)
                      VALUES ('t1', 'Test', 'anthropic', 'claude-opus-5', 'p', 1000000000)
                      ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO universe (symbol, exchange, name)
                      VALUES ('HOSE:FPT', 'HOSE', 'FPT Corp')
                      ON CONFLICT DO NOTHING`);

  await assert.rejects(
    client.query(`INSERT INTO trades (agent_id, symbol, action, price, qty, reason, confidence)
                  VALUES ('t1', 'HOSE:FPT', 'BUY', 100, 100, 'test', 1.5)`),
    /violates check constraint/,
  );

  await assert.doesNotReject(
    client.query(`INSERT INTO trades (agent_id, symbol, action, price, qty, reason, confidence)
                  VALUES ('t1', 'HOSE:FPT', 'BUY', 100, 100, 'test', 0.72)`),
  );

  await assert.doesNotReject(
    client.query(`INSERT INTO trades (agent_id, symbol, action, price, qty, reason, confidence)
                  VALUES ('t1', 'HOSE:FPT', 'BUY', 100, 100, 'test', NULL)`),
  );
});

test('news_items.sentiment bị giới hạn trong khoảng -1..1', async () => {
  await assert.rejects(
    client.query(`INSERT INTO news_items (source, url, title, sentiment)
                  VALUES ('test', 'https://example.com/a', 'title a', -2)`),
    /violates check constraint/,
  );

  await assert.doesNotReject(
    client.query(`INSERT INTO news_items (source, url, title, sentiment)
                  VALUES ('test', 'https://example.com/b', 'title b', -0.8)`),
  );
});

test('lessons.confidence bị giới hạn trong khoảng 0..1 và có DEFAULT 0.5', async () => {
  await client.query(`INSERT INTO agents (id, name, provider, model, persona_prompt, initial_capital)
                      VALUES ('t1', 'Test', 'anthropic', 'claude-opus-5', 'p', 1000000000)
                      ON CONFLICT DO NOTHING`);

  await assert.rejects(
    client.query(`INSERT INTO lessons (agent_id, lesson, confidence)
                  VALUES ('t1', 'test lesson', 1.5)`),
    /violates check constraint/,
  );

  await assert.doesNotReject(
    client.query(`INSERT INTO lessons (agent_id, lesson, confidence)
                  VALUES ('t1', 'test lesson', 0.81)`),
  );

  // confidence is NOT NULL DEFAULT 0.5 — an explicit NULL must be rejected by
  // the NOT NULL constraint, not silently accepted.
  await assert.rejects(
    client.query(`INSERT INTO lessons (agent_id, lesson, confidence)
                  VALUES ('t1', 'test lesson', NULL)`),
    /violates not-null constraint/,
  );

  // Omitting the column entirely should fall back to the DEFAULT of 0.5.
  const { rows } = await client.query(
    `INSERT INTO lessons (agent_id, lesson) VALUES ('t1', 'test lesson') RETURNING confidence`,
  );
  assert.equal(Number(rows[0].confidence), 0.5);
});

test('metrics_daily.win_rate bị giới hạn trong khoảng 0..1', async () => {
  await client.query(`INSERT INTO agents (id, name, provider, model, persona_prompt, initial_capital)
                      VALUES ('t1', 'Test', 'anthropic', 'claude-opus-5', 'p', 1000000000)
                      ON CONFLICT DO NOTHING`);

  await assert.rejects(
    client.query(`INSERT INTO metrics_daily (agent_id, snap_date, win_rate)
                  VALUES ('t1', '2026-07-20', 1.5)`),
    /violates check constraint/,
  );

  await assert.doesNotReject(
    client.query(`INSERT INTO metrics_daily (agent_id, snap_date, win_rate)
                  VALUES ('t1', '2026-07-21', 0.64)`),
  );

  await assert.doesNotReject(
    client.query(`INSERT INTO metrics_daily (agent_id, snap_date, win_rate)
                  VALUES ('t1', '2026-07-22', NULL)`),
  );
});

test('fills.agent_id phải khớp agent_id của order cha', async () => {
  await client.query(`INSERT INTO agents (id, name, provider, model, persona_prompt, initial_capital)
                      VALUES ('a1', 'A1', 'anthropic', 'claude-opus-5', 'p', 1000000000),
                             ('a2', 'A2', 'openai', 'gpt', 'p', 1000000000)
                      ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT', 'HOSE')
                      ON CONFLICT DO NOTHING`);
  const { rows } = await client.query(
    `INSERT INTO orders (agent_id, symbol, side, qty, order_type, status)
     VALUES ('a1', 'HOSE:FPT', 'BUY', 100, 'MARKET', 'FILLED') RETURNING id`);
  const orderId = rows[0].id;

  // Khớp -> chấp nhận
  await assert.doesNotReject(
    client.query(`INSERT INTO fills (order_id, agent_id, qty, price)
                  VALUES ($1, 'a1', 100, 110)`, [orderId]),
  );

  // Lệch -> phải bị chặn ở tầng database, không phụ thuộc tầng ứng dụng nhớ join
  await assert.rejects(
    client.query(`INSERT INTO fills (order_id, agent_id, qty, price)
                  VALUES ($1, 'a2', 100, 110)`, [orderId]),
    /không khớp/,
  );
});
