import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo, createLessonsRepo } from '@stockagents/db';
import { cosine, topK } from '../src/memory/similarity.js';
import {
  scoreLesson, shouldRetire, outcomeHelped,
  RETIRE_BELOW, MIN_RETRIEVALS_BEFORE_RETIRE,
} from '../src/learning/scorer.js';

let client, repos;
const TABLES = ['lesson_usage', 'lessons', 'position_lots', 'fills', 'orders',
  'trade_outcomes', 'trades', 'positions', 'portfolio_snapshot', 'metrics_daily',
  'agents', 'universe'];

before(async () => {
  client = await withTestDb();
  repos = {
    agents: createAgentsRepo(client), trading: createTradingRepo(client),
    lessons: createLessonsRepo(client),
  };
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
    { id: 'a2', name: 'A2', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

const trade = (agentId, reason = 'r') => repos.trading.insertTrade(agentId, {
  symbol: 'HOSE:FPT', action: 'BUY', priceVnd: 100_000, qty: 100, reason, confidence: 0.5,
});

/* ---------- Cosine ---------- */

test('cosine bằng 1 với vector trùng nhau, 0 với vector vuông góc', () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('cosine không phụ thuộc độ dài vector', () => {
  assert.ok(Math.abs(cosine([1, 1], [5, 5]) - 1) < 1e-12);
});

test('cosine trả -1 với vector ngược chiều', () => {
  assert.ok(Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-12);
});

test('cosine trả 0 khi có vector toàn số 0, không chia cho 0', () => {
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test('cosine từ chối vector lệch độ dài hoặc rỗng', () => {
  assert.throws(() => cosine([1, 2], [1]), /cùng độ dài/);
  assert.throws(() => cosine([], []), /khác rỗng/);
});

/* ---------- topK ---------- */

test('topK xếp theo similarity NHÂN confidence, không chỉ theo similarity', () => {
  const q = [1, 0];
  const items = [
    { id: 'giong-nhung-vo-dung', embedding: [1, 0], confidence: 0.1 },
    { id: 'kem-giong-nhung-tin-cay', embedding: [0.8, 0.6], confidence: 0.95 },
  ];
  const out = topK({ queryVector: q, items, k: 2 });
  assert.equal(out[0].id, 'kem-giong-nhung-tin-cay',
    'bài học đã chứng minh vô dụng không được đứng trên bài học đã cứu nhiều lệnh');
});

test('topK giới hạn đúng k', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: i, embedding: [1, i / 20], confidence: 0.5 }));
  assert.equal(topK({ queryVector: [1, 0], items, k: 5 }).length, 5);
});

test('topK bỏ qua item có embedding lệch chiều thay vì ném lỗi', () => {
  const items = [
    { id: 'ok', embedding: [1, 0], confidence: 0.8 },
    { id: 'lech', embedding: [1, 0, 0], confidence: 0.9 },
    { id: 'thieu', confidence: 0.9 },
  ];
  const out = topK({ queryVector: [1, 0], items, k: 10 });
  assert.deepEqual(out.map(o => o.id), ['ok']);
});

test('topK lọc theo minScore', () => {
  const items = [{ id: 'yeu', embedding: [0, 1], confidence: 0.5 }];
  assert.equal(topK({ queryVector: [1, 0], items, k: 10, minScore: 0.1 }).length, 0);
});

/* ---------- Chấm điểm ---------- */

test('bài học mới tinh có điểm 0,5 — đúng bằng mặc định của cột', () => {
  assert.equal(scoreLesson({ timesHelped: 0, timesRetrieved: 0 }), 0.5);
});

test('làm mượt Laplace: trúng một lần không nhảy lên 1,0', () => {
  const s = scoreLesson({ timesHelped: 1, timesRetrieved: 1 });
  assert.ok(s > 0.5 && s < 0.8, `kỳ vọng tăng vừa phải, nhận ${s}`);
});

test('trúng nhiều lần thì điểm tiến dần lên cao', () => {
  const s = scoreLesson({ timesHelped: 20, timesRetrieved: 20 });
  assert.ok(s > 0.9, `nhận ${s}`);
});

test('trượt nhiều lần thì điểm tụt xuống thấp', () => {
  const s = scoreLesson({ timesHelped: 0, timesRetrieved: 20 });
  assert.ok(s < 0.1, `nhận ${s}`);
});

test('scoreLesson từ chối dữ liệu vô lý (giúp nhiều hơn số lần được dùng)', () => {
  assert.throws(() => scoreLesson({ timesHelped: 5, timesRetrieved: 2 }), /không thể lớn hơn/);
});

test('chỉ loại bài học vừa yếu vừa ĐÃ ĐƯỢC THỬ đủ nhiều', () => {
  assert.equal(RETIRE_BELOW, 0.3);
  assert.equal(MIN_RETRIEVALS_BEFORE_RETIRE, 10);
  assert.equal(shouldRetire({ confidence: 0.1, timesRetrieved: 12 }), true);
  assert.equal(shouldRetire({ confidence: 0.1, timesRetrieved: 3 }), false,
    'chưa thử đủ nhiều thì chưa được kết luận là vô dụng');
  assert.equal(shouldRetire({ confidence: 0.8, timesRetrieved: 50 }), false);
});

test('chỉ lệnh LÃI mới tính là bài học đã giúp', () => {
  assert.equal(outcomeHelped(1_000_000), true);
  assert.equal(outcomeHelped(0), false);
  assert.equal(outcomeHelped(-1), false);
  assert.equal(outcomeHelped(NaN), false);
});

/* ---------- Repository ---------- */

test('lessons bị cô lập giữa các agent', async () => {
  await repos.lessons.insert('a1', { lesson: 'bài của a1' });
  await repos.lessons.insert('a2', { lesson: 'bài của a2' });

  const a1 = await repos.lessons.listActive('a1');
  assert.equal(a1.length, 1);
  assert.equal(a1[0].lesson, 'bài của a1');
});

test('hàm lessons từ chối khi thiếu agentId', async () => {
  await assert.rejects(() => repos.lessons.listActive(), /agentId/);
  await assert.rejects(() => repos.lessons.insert(null, { lesson: 'x' }), /agentId/);
});

test('embedding lưu và đọc lại nguyên vẹn', async () => {
  const vec = [0.1, -0.2, 0.3];
  await repos.lessons.insert('a1', { lesson: 'có vector', embedding: vec });
  const [l] = await repos.lessons.listActive('a1');
  assert.deepEqual(l.embedding, vec);
});

test('recordRetrieval đếm số lần bài học được đưa vào prompt', async () => {
  const { id } = await repos.lessons.insert('a1', { lesson: 'x' });
  const t = await trade('a1');
  await repos.lessons.recordRetrieval('a1', id, t.id);

  const [l] = await repos.lessons.listActive('a1');
  assert.equal(l.timesRetrieved, 1);
  assert.equal(l.timesHelped, 0);
});

test('lệnh lãi làm điểm bài học tăng; lệnh lỗ thì không', async () => {
  const good = await repos.lessons.insert('a1', { lesson: 'bài tốt' });
  const bad = await repos.lessons.insert('a1', { lesson: 'bài tệ' });
  const t1 = await trade('a1', 'lệnh một');
  const t2 = await trade('a1', 'lệnh hai');

  await repos.lessons.recordRetrieval('a1', good.id, t1.id);
  await repos.lessons.recordRetrieval('a1', bad.id, t2.id);
  await repos.lessons.applyOutcome('a1', t1.id, outcomeHelped(5_000_000), scoreLesson);
  await repos.lessons.applyOutcome('a1', t2.id, outcomeHelped(-3_000_000), scoreLesson);

  const list = await repos.lessons.listActive('a1');
  const g = list.find(l => l.lesson === 'bài tốt');
  const b = list.find(l => l.lesson === 'bài tệ');
  assert.ok(g.confidence > b.confidence, `tốt ${g.confidence} phải hơn tệ ${b.confidence}`);
  assert.equal(g.timesHelped, 1);
  assert.equal(b.timesHelped, 0);
});

test('applyOutcome không tính hai lần cho cùng một lệnh', async () => {
  const { id } = await repos.lessons.insert('a1', { lesson: 'x' });
  const t = await trade('a1');
  await repos.lessons.recordRetrieval('a1', id, t.id);

  await repos.lessons.applyOutcome('a1', t.id, true, scoreLesson);
  const applied = await repos.lessons.applyOutcome('a1', t.id, true, scoreLesson);

  assert.equal(applied, 0, 'lần hai không được cộng thêm');
  const [l] = await repos.lessons.listActive('a1');
  assert.equal(l.timesHelped, 1);
});

test('pruneWeak loại bài học vừa yếu vừa đã thử nhiều, giữ bài chưa thử đủ', async () => {
  const weak = await repos.lessons.insert('a1', { lesson: 'yếu và đã thử nhiều', confidence: 0.1 });
  const young = await repos.lessons.insert('a1', { lesson: 'yếu nhưng còn mới', confidence: 0.1 });
  await client.query(`UPDATE lessons SET times_retrieved = 15 WHERE id = $1`, [weak.id]);
  await client.query(`UPDATE lessons SET times_retrieved = 2 WHERE id = $1`, [young.id]);

  const n = await repos.lessons.pruneWeak('a1',
    { below: RETIRE_BELOW, minRetrievals: MIN_RETRIEVALS_BEFORE_RETIRE });

  assert.equal(n, 1);
  const left = await repos.lessons.listActive('a1');
  assert.deepEqual(left.map(l => l.lesson), ['yếu nhưng còn mới']);
});

test('bài học đã loại KHÔNG bao giờ quay lại prompt', async () => {
  const { id } = await repos.lessons.insert('a1', { lesson: 'mê tín' });
  await repos.lessons.retire('a1', id);
  assert.deepEqual(await repos.lessons.listActive('a1'), []);
});

test('listActive sắp theo confidence giảm dần', async () => {
  await repos.lessons.insert('a1', { lesson: 'thấp', confidence: 0.2 });
  await repos.lessons.insert('a1', { lesson: 'cao', confidence: 0.9 });
  const list = await repos.lessons.listActive('a1');
  assert.deepEqual(list.map(l => l.lesson), ['cao', 'thấp']);
});
