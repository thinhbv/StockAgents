import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
let client;

before(async () => {
  client = createClient(cfg.databaseUrlTest);
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});

after(async () => { await client.close(); });

test('runMigrations áp dụng migration và ghi lại vào schema_migrations', async () => {
  const applied = await runMigrations(client);
  assert.ok(applied.includes('002_market.sql'));

  const { rows } = await client.query('SELECT name FROM schema_migrations ORDER BY name');
  assert.ok(rows.some(r => r.name === '002_market.sql'));
});

test('runMigrations là idempotent — chạy lần hai không áp dụng gì thêm', async () => {
  const applied = await runMigrations(client);
  assert.deepEqual(applied, []);
});

test('bookkeeping insert lỗi khiến toàn bộ migration (kể cả DDL) bị rollback', async () => {
  // Thay cho bài test cũ (SQL body: 'CREATE TABLE ...; SELECT 1/0;') — bài đó
  // không thể phân biệt được có bọc transaction hay không: cả thân SQL lẫn
  // lỗi đều nằm trong MỘT lệnh query() gửi qua simple query protocol của
  // node-postgres, vốn đã tự bọc transaction ngầm; và vì await ném lỗi
  // trước, INSERT vào schema_migrations không bao giờ chạy tới.
  // Bài test này ép: thân DDL của migration THÀNH CÔNG, còn INSERT vào
  // schema_migrations mới là bước thất bại (qua trigger bẫy) — chỉ khi
  // runMigrations thực sự bọc cả hai bước trong cùng một transaction thì DDL
  // mới bị cuốn theo rollback.
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  await client.query(`
    CREATE OR REPLACE FUNCTION trap_bad_migration_insert() RETURNS trigger AS $$
    BEGIN
      IF NEW.name = '901_trap.sql' THEN
        RAISE EXCEPTION 'trap: simulated bookkeeping failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await client.query(`
    CREATE TRIGGER trap_bad_migration_insert_trigger
    BEFORE INSERT ON schema_migrations
    FOR EACH ROW EXECUTE FUNCTION trap_bad_migration_insert();
  `);

  try {
    const dir = await mkdtemp(join(tmpdir(), 'mig-trap-'));
    // Thân migration này, đứng một mình, hoàn toàn hợp lệ và sẽ chạy thành công.
    await writeFile(join(dir, '901_trap.sql'), 'CREATE TABLE trap_probe (v INT);');

    await assert.rejects(runMigrations(client, { dir }), /trap: simulated bookkeeping failure/);

    const t = await client.query("SELECT to_regclass('public.trap_probe') AS r");
    assert.equal(t.rows[0].r, null,
      'DDL của migration (vốn tự nó thành công) phải bị rollback theo vì INSERT bookkeeping thất bại');

    const m = await client.query(
      "SELECT 1 FROM schema_migrations WHERE name = '901_trap.sql'");
    assert.equal(m.rows.length, 0);
  } finally {
    await client.query('DROP TRIGGER IF EXISTS trap_bad_migration_insert_trigger ON schema_migrations');
    await client.query('DROP FUNCTION IF EXISTS trap_bad_migration_insert()');
  }
});

test('hai tiến trình cùng gọi runMigrations() một lúc trên schema trắng không đụng độ nhau', async () => {
  // Đúng kịch bản thật: data-service, api, telegram-bot cùng khởi động và
  // cùng tự chạy migration. Không có khoá advisory, cả hai sẽ cùng thấy
  // schema_migrations trống rồi cùng CREATE TABLE — một bên lỗi "relation
  // already exists". Dùng client THỨ HAI (kết nối riêng) để mô phỏng đúng
  // hai tiến trình khác nhau, không phải hai lời gọi trên cùng một client.
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const client2 = createClient(cfg.databaseUrlTest);
  try {
    const [a, b] = await Promise.all([runMigrations(client), runMigrations(client2)]);
    // Tổng số file áp dụng qua CẢ HAI lời gọi phải đúng bằng số migration có
    // — không file nào bị áp dụng hai lần (advisory lock tuần tự hoá đúng).
    assert.deepEqual(new Set([...a, ...b]).size, a.length + b.length);
    assert.ok(a.length + b.length > 0);
  } finally {
    await client2.close();
  }
});

test('withTransaction rollback khi callback ném lỗi', async () => {
  await client.query('CREATE TABLE IF NOT EXISTS tx_probe (v INT)');
  await assert.rejects(
    client.withTransaction(async (tx) => {
      await tx.query('INSERT INTO tx_probe (v) VALUES (1)');
      throw new Error('bùm');
    }),
    /bùm/,
  );
  const { rows } = await client.query('SELECT * FROM tx_probe');
  assert.equal(rows.length, 0);
});
