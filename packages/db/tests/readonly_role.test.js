import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { withTestDb } from '../../../tests/helpers/db.js';

let admin, ro;

before(async () => {
  admin = await withTestDb();   // chạy migration, tạo role
  const url = loadConfig().databaseUrlTest
    .replace(/\/\/[^:]+:[^@]+@/, '//stockagents_ro:readonly@');
  ro = createClient(url);
});
after(async () => { await admin.close(); await ro.close(); });

test('role chỉ đọc ĐỌC được dữ liệu', async () => {
  const { rows } = await ro.query('SELECT count(*)::int n FROM agents');
  assert.ok(Number.isInteger(rows[0].n));
});

test('role chỉ đọc KHÔNG ghi được — đây là hàng rào thật, không phải quy ước', async () => {
  await assert.rejects(
    ro.query(`INSERT INTO event_log (type, payload) VALUES ('hack','{}')`),
    /permission denied/,
  );
});

test('role chỉ đọc không xoá được', async () => {
  await assert.rejects(ro.query('DELETE FROM event_log'), /permission denied/);
});

test('role chỉ đọc không sửa được danh mục', async () => {
  await assert.rejects(ro.query('UPDATE agents SET cash_vnd = 0'), /permission denied/);
});

test('role chỉ đọc không tạo được bảng mới', async () => {
  await assert.rejects(ro.query('CREATE TABLE hack (x INT)'), /permission denied/);
});
