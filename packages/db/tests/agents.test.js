import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo } from '../src/repositories/agents.js';

let client, agents;
const TABLES = ['portfolio_snapshot', 'agents'];

before(async () => {
  client = await withTestDb();
  agents = createAgentsRepo(client);
});
beforeEach(async () => { await resetTables(client, TABLES); });
after(async () => { await client.close(); });

const def = (overrides = {}) => ({
  id: 'a1', name: 'A1', provider: 'stub', model: 'stub',
  personaPrompt: 'p', initialCapital: 1_000_000_000, ...overrides,
});

test('upsertMany mặc định active = true khi def không khai báo trường này', async () => {
  await agents.upsertMany([def()]);
  const a = await agents.get('a1');
  assert.equal(a.active, true);
});

test('upsertMany đặt active = false khi def khai báo active:false — tạm dừng, không xóa', async () => {
  await agents.upsertMany([def({ active: false })]);
  const a = await agents.get('a1');
  assert.equal(a.active, false);
  // Vẫn còn đủ thông tin agent — "tạm dừng" không phải "xóa".
  assert.equal(a.name, 'A1');
});

test('listActive loại agent active=false khỏi danh sách, nhưng không xóa bản ghi', async () => {
  await agents.upsertMany([def({ id: 'a1' }), def({ id: 'a2', active: false })]);
  const ids = await agents.listActive();
  assert.deepEqual(ids, ['a1']);
  assert.ok(await agents.get('a2'), 'agent tạm dừng vẫn phải còn trong DB');
});

test('upsertMany lại với active thay đổi thì cập nhật — bật/tắt tạm dừng không cần xóa DB tay', async () => {
  await agents.upsertMany([def({ active: true })]);
  assert.equal((await agents.get('a1')).active, true);

  await agents.upsertMany([def({ active: false })]);
  assert.equal((await agents.get('a1')).active, false);

  await agents.upsertMany([def({ active: true })]);
  assert.equal((await agents.get('a1')).active, true, 'mở lại được, không cần tạo agent mới');
});

test('agent tạm dừng (active=false) vẫn giữ nguyên tiền mặt/vị thế đã có, không bị reset', async () => {
  await agents.upsertMany([def()]);
  await agents.setCash('a1', 500_000_000);

  await agents.upsertMany([def({ active: false })]);

  assert.equal(await agents.getCash('a1'), 500_000_000, 'tạm dừng không được nạp lại tiền ban đầu');
});
